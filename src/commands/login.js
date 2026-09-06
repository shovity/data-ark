import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

import { loadConfig, saveConfig, defaultConfigDir } from '../config.js'
import { normalizeChatTarget } from '../chat.js'
import { closeQuietly, connect as realConnect, createLogger } from '../client.js'
import { createPrompts } from '../prompt.js'
import { knownSettings, resolveSettings } from '../settings.js'
import { decodeToken, isSealedToken } from '../token.js'

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

// GramJS starts an update loop the moment a client connects, and that loop only stops when
// destroy() marks the client destroyed. disconnect() alone leaves it pinging a socket that is
// already closed: every ping fails with "Error: TIMEOUT" and asks the sender to reconnect,
// printed straight over the destination question login asks after signing in. Every other
// command shuts down the same way, and login is the seam tests need to reach it.
const createTelegramClient = (apiId, apiHash, options) =>
  new TelegramClient(new StringSession(''), apiId, apiHash, options)

// The token never reaches here as an argument, and telstore refuses to pretend otherwise: a
// token on the command line sits in the shell history of a machine the user does not trust,
// and ignoring it silently would leave it there for nothing.
function refuseArguments(args) {
  if (args.length === 0) return

  throw new Error(
    'login takes no arguments. A session token is pasted at a prompt, never written on the ' +
      'command line — there it stays in this machine\'s shell history and is visible in "ps" ' +
      'for as long as the command runs. Run "npx telstore login --token" and paste it when asked.',
  )
}

// Logging in with a token telstore printed elsewhere. The blob is stored exactly as it
// arrived rather than opened and written back out: what makes this worth doing is that the
// session never exists on this machine's disk in a form anyone can read.
async function loginWithToken({ configDir, prompts, connectWith, shutdown, verbose, log }) {
  const token = (await prompts.askSecret('Session token: ')).trim()
  const passphrase = isSealedToken(token) ? await prompts.askSecret('Passphrase for the token: ') : ''

  // Opened here, before anything is written, so a wrong passphrase is a sentence now rather
  // than a failure at the start of a restore that was going to take twenty minutes.
  const bundle = await decodeToken(token, passphrase)
  const account = { apiId: bundle.apiId, apiHash: bundle.apiHash, session: bundle.session }

  // A token says what the session was when it was made. Only Telegram can say whether that
  // session is still alive, and finding out now is the difference between a login that failed
  // and a login that appeared to work.
  const client = await connectWith(account, { verbose })

  let me
  try {
    me = await client.getMe()
  } finally {
    await closeQuietly(client, shutdown)
  }

  const config = await loadConfig(configDir)
  // Built fresh rather than merged over what was there: a config holding both a sealed
  // session and a plain one is refused on the next run, and merging is how it would come to
  // hold both. Settings are the exception, because they are nobody's secret.
  const next = passphrase === '' ? { ...account } : { sealed: token }
  const settings = { ...config.settings, ...knownSettings(bundle.settings) }

  if (Object.keys(settings).length > 0) next.settings = settings

  await saveConfig(next, configDir)

  log(`\nLogged in as ${me.username ? `@${me.username}` : me.firstName}.`)

  if (passphrase === '') {
    log(
      `Config saved to ${configDir}/config.json. This token had no passphrase, so the session ` +
        'is stored here in plain text, exactly as an ordinary login would store it.',
    )
    return
  }

  log(
    `Config saved to ${configDir}/config.json, with the session sealed behind your ` +
      'passphrase. Every command that talks to Telegram will ask for it.',
  )
}

export async function runLogin({
  configDir = defaultConfigDir(),
  args = [],
  token = false,
  prompts = null,
  connectWith = realConnect,
  verbose = false,
  createClient = createTelegramClient,
  shutdown = (client) => client.destroy(),
  log = (line) => console.log(line),
} = {}) {
  refuseArguments(args)

  // Opened here and not in the parameter list: a default argument runs on every call, so the
  // refusal above would open a readline on stdin it never reads from and the process would
  // hang with nothing left to do.
  prompts = prompts ?? createPrompts()

  if (token) {
    try {
      return await loginWithToken({ configDir, prompts, connectWith, shutdown, verbose, log })
    } finally {
      prompts.close()
    }
  }

  const config = await loadConfig(configDir)
  const storedChat = config.settings?.chat
  const loud = verbose || resolveSettings({}, config).values.verbose

  log('You need your own api_id and api_hash. Get them at https://my.telegram.org → API development tools.\n')

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

  const client = createClient(apiId, apiHash, {
    connectionRetries: 5,
    baseLogger: createLogger(loud),
  })

  await client.start({
    phoneNumber: () => prompts.ask('Phone number (e.g. +1...): '),
    phoneCode: () => prompts.ask('Verification code Telegram just sent: '),
    password: () => prompts.askSecret('Two-step password (leave blank if not enabled): '),
    onError: (err) => console.error(`Login failed: ${describeLoginError(err)}`),
  })

  const me = await client.getMe()
  const session = client.session.save()
  await shutdown(client)

  const chatAnswer = (
    await prompts.ask(
      `Which chat should backups go to? (@username, -100..., or me)${storedChat ? ` [${storedChat}]` : ''}, Enter to skip: `,
    )
  ).trim()

  prompts.close()

  const next = { ...config, apiId, apiHash, session }

  if (chatAnswer !== '') {
    next.settings = { ...config.settings, chat: String(normalizeChatTarget(chatAnswer)) }
  }

  await saveConfig(next, configDir)

  log(`\nLogged in as ${me.username ? `@${me.username}` : me.firstName}.`)
  log(`Config saved to ${configDir}/config.json`)
}
