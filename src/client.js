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

export function normalizeChatTarget(input) {
  const text = String(input).trim()

  if (text === '') {
    throw new Error('Destination must not be empty.')
  }

  if (/^-?\d+$/.test(text)) {
    return Number(text)
  }

  return text
}

// Telegram's web client addresses a chat by putting the raw target in the fragment, which
// covers both a negative channel id and an @username. Saved Messages is the exception: it
// is reached by the account's own id, which data-ark does not know, so it gets no link
// rather than a guessed one that lands somewhere else.
export function chatUrl(chat) {
  const text = String(chat)

  if (text === 'me') return null

  return `https://web.telegram.org/k/#${text}`
}

// How a destination is spoken about. "me" is a target, not a name someone would recognise
// in a sentence, so every command that mentions a chat in prose goes through here.
export function chatName(chat) {
  return String(chat) === 'me' ? 'Saved Messages' : String(chat)
}

// A destination is worth more as something clickable than as a raw id, but Saved Messages
// has no link to give, so it is named instead of being dressed up as one.
export function describeChat(chat) {
  const url = chatUrl(chat)

  return url ?? `${chat} (${chatName(chat)})`
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

export function requireChat(options, config) {
  const raw = options.to ?? config.defaultChat

  if (!raw) {
    throw new Error(
      'No destination set — run again with --to @my_backups (or --to me for Saved Messages). ' +
        'data-ark will remember it next time.',
    )
  }

  return normalizeChatTarget(raw)
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
