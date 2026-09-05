import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

import { loadConfig, saveConfig, defaultConfigDir } from '../config.js'
import { createLogger, normalizeChatTarget } from '../client.js'

function createPrompts() {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  return {
    ask: (question) => rl.question(question),
    close: () => rl.close(),
  }
}

const LOGIN_ERROR_MESSAGES = {
  PHONE_NUMBER_INVALID: 'invalid phone number',
  PHONE_CODE_INVALID: 'wrong verification code',
  PHONE_CODE_EXPIRED: 'verification code expired',
  PASSWORD_HASH_INVALID: 'wrong two-step password',
  FLOOD_WAIT: 'rate limited by Telegram, need to wait',
}

export function describeLoginError(err) {
  const message = String(err?.message ?? err ?? '')
  const known = Object.entries(LOGIN_ERROR_MESSAGES).find(([code]) => message.startsWith(code))

  if (!known) return message

  const [, description] = known
  return `${description} (${message})`
}

export async function runLogin({
  configDir = defaultConfigDir(),
  prompts = createPrompts(),
  verbose = false,
} = {}) {
  const config = await loadConfig(configDir)

  console.log('You need your own api_id and api_hash. Get them at https://my.telegram.org → API development tools.\n')

  const apiIdAnswer = (await prompts.ask(`api_id${config.apiId ? ` [${config.apiId}]` : ''}: `)).trim()

  if (apiIdAnswer !== '' && !/^\d+$/.test(apiIdAnswer)) {
    prompts.close()
    throw new Error('api_id must be an integer.')
  }

  const apiId = apiIdAnswer === '' ? config.apiId : Number(apiIdAnswer)
  const apiHash = (await prompts.ask(`api_hash${config.apiHash ? ' [keep current]' : ''}: `)) || config.apiHash

  if (!apiId || !apiHash) {
    prompts.close()
    throw new Error('Missing api_id or api_hash.')
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
    baseLogger: createLogger(verbose),
  })

  await client.start({
    phoneNumber: () => prompts.ask('Phone number (e.g. +1...): '),
    phoneCode: () => prompts.ask('Verification code Telegram just sent: '),
    password: () => prompts.ask('Two-step password (leave blank if not enabled): '),
    onError: (err) => console.error(`Login failed: ${describeLoginError(err)}`),
  })

  const me = await client.getMe()
  const session = client.session.save()
  await client.disconnect()

  const chatAnswer = (
    await prompts.ask(
      `Which chat should backups go to? (@username, -100..., or me)${config.defaultChat ? ` [${config.defaultChat}]` : ''}, Enter to skip: `,
    )
  ).trim()

  prompts.close()

  const next = { ...config, apiId, apiHash, session }

  if (chatAnswer !== '') {
    next.defaultChat = String(normalizeChatTarget(chatAnswer))
  }

  await saveConfig(next, configDir)

  console.log(`\nLogged in as ${me.username ? `@${me.username}` : me.firstName}.`)
  console.log(`Config saved to ${configDir}/config.json`)
}
