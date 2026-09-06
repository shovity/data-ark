import { Api, TelegramClient } from 'telegram'
import { Logger } from 'telegram/extensions/index.js'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { StringSession } from 'telegram/sessions/index.js'

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

// The one place data-ark searches a chat. Both callers want documents and nothing else,
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

export function assertLoggedIn(config) {
  if (!config.session || !config.apiId || !config.apiHash) {
    throw new Error('Not logged in — run "npx data-ark login" first.')
  }
}

export async function connect(config, { verbose = false } = {}) {
  assertLoggedIn(config)

  const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
    baseLogger: createLogger(verbose),
  })

  await client.connect()

  if (!(await client.isUserAuthorized())) {
    throw new Error('Session expired — run "npx data-ark login".')
  }

  return client
}
