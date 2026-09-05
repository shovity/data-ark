import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

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

export async function connect(config) {
  assertLoggedIn(config)

  const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
  })

  await client.connect()

  if (!(await client.isUserAuthorized())) {
    throw new Error('Session expired — run "npx data-ark login".')
  }

  return client
}
