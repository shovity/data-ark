import { Api, TelegramClient } from 'telegram'
import { Logger } from 'telegram/extensions/index.js'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { StringSession } from 'telegram/sessions/index.js'

import { manifestFileName } from './manifest.js'
import { withRetry } from './retry.js'
import { unlockConfig } from './session.js'
import { DEFAULT_STALL_MS, withStallTimeout } from './stall.js'

// GramJS narrates its version, every connection and every disconnect at info level, and
// those timestamped lines land in the middle of the progress bar. The client reads this
// logger before it prints anything, so LogLevel.NONE silences all of it; --verbose asks
// for the running commentary back when a connection needs diagnosing.
export function createLogger(verbose) {
  return new Logger(verbose ? LogLevel.INFO : LogLevel.NONE)
}

// The name Telegram shows under a document lives in an attribute, not on the message.
export function documentFileName(message) {
  const attributes = message?.media?.document?.attributes ?? []
  const named = attributes.find((a) => a instanceof Api.DocumentAttributeFilename)
  return named?.fileName ?? null
}

// The one place telstore searches a chat. Both callers want documents and nothing else,
// and getMessages is preferred over a raw Api.messages.Search because it handles offsets,
// hashes and pagination itself, so we don't hand-build easily mistyped fields. The raw
// message is kept alongside the flat fields because downloading needs it whole.
export async function searchDocuments(client, peer, { search, limit }) {
  const messages = await client.getMessages(peer, {
    search,
    filter: new Api.InputMessagesFilterDocument(),
    limit,
  })

  return messages.map((message) => ({
    id: message.id,
    fileName: documentFileName(message),
    caption: message.message ?? '',
    date: message.date,
    message,
  }))
}

// How telstore finds a backup's manifest, in one place because restore and delete must not
// disagree about it. The search is by backup id, but the answer is decided by the file name
// telstore itself wrote — a caption is text a person can edit, a file name is not.
export async function findManifestMessage(client, peer, backupId) {
  const wanted = manifestFileName(backupId)
  const found = await searchDocuments(client, peer, { search: backupId, limit: 100 })

  return found.find((doc) => doc.fileName === wanted)?.message ?? null
}

export async function readMessageBytes(client, message) {
  return await client.downloadMedia(message)
}

// The one place telstore removes messages from a chat, and the mirror of searchDocuments
// above. GramJS has its own deleteMessages, and it is the right thing to call — it resolves
// the peer and picks between channels.DeleteMessages and messages.DeleteMessages, which is
// exactly the choice a fake client would never catch us getting wrong.
//
// What it does on top of that is the problem: it splits the ids into batches of a hundred
// and fires every batch at once through Promise.all. A ten-thousand-chunk backup would put
// a hundred requests in flight together, none of them under the retry policy or the stall
// deadline that every other network wait in telstore carries. Batching here instead keeps
// one request outstanding at a time, under both.
//
// Telegram does not complain about an id that is no longer there, so sending a batch twice
// costs nothing: a delete interrupted halfway is finished by running it again.
export const DELETE_BATCH_SIZE = 100

export async function deleteMessages(client, peer, ids, options = {}) {
  const {
    batchSize = DELETE_BATCH_SIZE,
    retryOptions = {},
    stallMs = DEFAULT_STALL_MS,
    onBatch,
  } = options

  let deleted = 0

  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize)

    await withRetry(
      () =>
        // The options object is not optional: GramJS destructures `{ revoke }` with no
        // default of its own, so a two-argument call throws a TypeError before it ever
        // reaches the network. revoke is passed explicitly anyway — a backup has to go for
        // everyone who can see the chat, and that intent belongs in our code rather than in
        // a dependency's default.
        withStallTimeout(
          client.deleteMessages(peer, batch, { revoke: true }),
          stallMs,
          () =>
            `Telegram stopped answering while removing messages ${start + 1}-` +
            `${start + batch.length} of ${ids.length}: nothing back for ` +
            `${Math.round(stallMs / 1000)}s.`,
        ),
      retryOptions,
    )

    deleted += batch.length
    onBatch?.(deleted, ids.length)
  }

  return deleted
}

// Every command ends by putting the connection down, and a failure there must never
// swallow the real error already on its way up. Commands that print progress hand in an
// onWarn to say so; the quieter ones let it pass, because a connection that will not
// close cleanly says nothing about the work that already succeeded.
export async function closeQuietly(client, disconnect, onWarn) {
  try {
    await disconnect(client)
  } catch (err) {
    if (onWarn) onWarn(err)
  }
}

// Two shapes count as logged in: the ordinary one login writes, and the sealed blob that
// "login --token" leaves, which holds the same three fields behind a passphrase. Checked
// before anything asks for that passphrase, so somebody who never logged in is told so rather
// than asked to type a secret for an account that is not there.
export function assertLoggedIn(config) {
  if (config.sealed) return

  if (!config.session || !config.apiId || !config.apiHash) {
    throw new Error('Not logged in — run "npx telstore login" first.')
  }
}

// Every command that needs Telegram comes through here, which makes this the one place a
// sealed session has to be opened. Doing it anywhere else would mean eight places to keep in
// step, and a ninth command would simply forget.
export async function connect(config, { verbose = false, unlock = unlockConfig } = {}) {
  assertLoggedIn(config)

  const { apiId, apiHash, session } = await unlock(config)

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
    baseLogger: createLogger(verbose),
  })

  await client.connect()

  if (!(await client.isUserAuthorized())) {
    throw new Error('Session expired — run "npx telstore login".')
  }

  return client
}
