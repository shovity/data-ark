import { TelegramClient } from 'telegram'
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
