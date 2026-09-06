import test from 'node:test'
import assert from 'node:assert/strict'

import { describeLoginError, runLogin } from '../src/commands/login.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

test('describeLoginError explains an invalid phone number', () => {
  assert.equal(
    describeLoginError({ message: 'PHONE_NUMBER_INVALID' }),
    'invalid phone number (PHONE_NUMBER_INVALID)',
  )
})

test('describeLoginError explains a wrong verification code', () => {
  assert.equal(describeLoginError({ message: 'PHONE_CODE_INVALID' }), 'wrong verification code (PHONE_CODE_INVALID)')
})

test('describeLoginError explains an expired verification code', () => {
  assert.equal(describeLoginError({ message: 'PHONE_CODE_EXPIRED' }), 'verification code expired (PHONE_CODE_EXPIRED)')
})

test('describeLoginError explains a wrong two-step password', () => {
  assert.equal(describeLoginError({ message: 'PASSWORD_HASH_INVALID' }), 'wrong two-step password (PASSWORD_HASH_INVALID)')
})

test('describeLoginError explains rate limiting and keeps the seconds', () => {
  assert.equal(
    describeLoginError({ message: 'FLOOD_WAIT_30' }),
    'rate limited by Telegram, need to wait (FLOOD_WAIT_30)',
  )
})

test('describeLoginError passes an unrecognised code through unchanged', () => {
  assert.equal(describeLoginError({ message: 'SOME_UNKNOWN_ERROR' }), 'SOME_UNKNOWN_ERROR')
})

// Answers the prompts in order, so a test reads like the session the user would have had.
function fakePrompts(answers) {
  const remaining = [...answers]

  return {
    asked: [],
    secretly: [],
    ask(question) {
      this.asked.push(question)
      return Promise.resolve(remaining.shift() ?? '')
    },
    askSecret(question) {
      this.asked.push(question)
      this.secretly.push(question)
      return Promise.resolve(remaining.shift() ?? '')
    },
    close() {
      this.closed = true
    },
  }
}

function fakeClient(calls) {
  return {
    session: { save: () => 'saved-session' },
    start: async () => calls.push('start'),
    getMe: async () => ({ username: 'someone', firstName: 'Some' }),
    disconnect: async () => calls.push('disconnect'),
    destroy: async () => calls.push('destroy'),
  }
}

// teleproto starts an update loop on connect that runs until _destroyed is set, and only
// destroy() sets it — disconnect() leaves it pinging a socket that is already closed. Every
// ping then fails with "Error: TIMEOUT" and asks the sender to reconnect, printed on top of
// the destination prompt that login asks after signing in.
test('runLogin shuts the client down for good, not just the socket', async () => {
  const calls = []
  const configDir = await tempDir('login')

  await runLogin({
    configDir,
    prompts: fakePrompts(['1234', 'hash', '']),
    createClient: () => fakeClient(calls),
    log: () => {},
  })

  assert.deepEqual(calls, ['start', 'destroy'])
})

test('the destination login asks for is written where the config command reads it', async () => {
  const configDir = await tempDir('login')

  await runLogin({
    configDir,
    prompts: fakePrompts(['1234', 'hash', '@my_backups']),
    createClient: () => fakeClient([]),
    log: () => {},
  })

  const config = await loadConfig(configDir)
  assert.equal(config.settings.chat, '@my_backups')
  assert.equal(config.session, 'saved-session')
})

// Logging in again must offer the destination already stored, or it reads as though the
// chat had been lost and the blank answer would look like the only option.
test('logging in again offers the destination already stored as the default', async () => {
  const configDir = await tempDir('login')
  await saveConfig({ settings: { chat: '@store' } }, configDir)
  const prompts = fakePrompts(['1234', 'hash', ''])

  await runLogin({ configDir, prompts, createClient: () => fakeClient([]), log: () => {} })

  assert.match(prompts.asked.join('\n'), /\[@store\]/)
  assert.equal((await loadConfig(configDir)).settings.chat, '@store')
})

// --- logging in on a machine that must not keep a readable session ---

import { encodeToken } from '../src/token.js'
import { promises as fsp } from 'node:fs'
import nodePath from 'node:path'

const TOKEN_ACCOUNT = {
  apiId: 123456,
  apiHash: '0123456789abcdef',
  session: '1BQANOTEuMTA4LjU2',
  settings: { chat: '@backups' },
}

function tokenDeps(configDir, { readSecret, ...extra } = {}) {
  return {
    configDir,
    token: true,
    prompts: {
      ask: () => {
        throw new Error('asked a login question it did not need')
      },
      askSecret: readSecret,
      close: () => {},
    },
    connectWith: async () => ({ getMe: async () => ({ username: 'sho' }) }),
    shutdown: async () => {},
    log: () => {},
    ...extra,
  }
}

function secrets(...lines) {
  const queue = [...lines]

  return (question) => {
    if (queue.length === 0) throw new Error(`nothing left to answer: ${question}`)
    return queue.shift()
  }
}

// The whole point of the flag. A token written on the command line stays in the history of a
// machine the user does not trust, and telstore must not ignore one silently while it sits
// there.
test('login refuses a token written on the command line and says where to paste it', async () => {
  const dir = await tempDir('login-token')

  await assert.rejects(
    () => runLogin({ configDir: dir, args: ['tls1.abc'], token: true }),
    /shell history/,
  )
})

test('login --token leaves a sealed session on disk and no readable one', async () => {
  const dir = await tempDir('login-token')
  const token = await encodeToken(TOKEN_ACCOUNT, 'a passphrase')

  await runLogin(tokenDeps(dir, { readSecret: secrets(token, 'a passphrase') }))

  const written = await fsp.readFile(nodePath.join(dir, 'config.json'), 'utf8')

  assert.doesNotMatch(written, /1BQANOTEuMTA4LjU2/)
  assert.doesNotMatch(written, /0123456789abcdef/)
  assert.equal(JSON.parse(written).sealed, token)
  assert.deepEqual(JSON.parse(written).settings, { chat: '@backups' })
})

// A config that looked encrypted and was not would be telstore lying about what it kept, so
// an unprotected token writes exactly the shape an ordinary login writes.
test('login with an unprotected token writes the ordinary shape rather than pretending', async () => {
  const dir = await tempDir('login-token')
  const token = await encodeToken(TOKEN_ACCOUNT, '')

  await runLogin(tokenDeps(dir, { readSecret: secrets(token) }))

  const config = await loadConfig(dir)

  assert.equal(config.sealed, undefined)
  assert.equal(config.session, TOKEN_ACCOUNT.session)
  assert.equal(config.apiId, TOKEN_ACCOUNT.apiId)
})

// Finding out at the start of a twenty-minute restore is finding out too late.
test('a wrong passphrase is caught at login and nothing is written', async () => {
  const dir = await tempDir('login-token')
  const token = await encodeToken(TOKEN_ACCOUNT, 'a passphrase')

  await assert.rejects(
    () => runLogin(tokenDeps(dir, { readSecret: secrets(token, 'the wrong one') })),
    /Could not open the session token/,
  )
  assert.deepEqual(await loadConfig(dir), {})
})

test('login --token proves the session still works before saying it worked', async () => {
  const dir = await tempDir('login-token')
  const token = await encodeToken(TOKEN_ACCOUNT, 'a passphrase')

  await assert.rejects(
    () =>
      runLogin(
        tokenDeps(dir, {
          readSecret: secrets(token, 'a passphrase'),
          connectWith: async () => {
            throw new Error('Session expired — run "npx telstore login".')
          },
        }),
      ),
    /Session expired/,
  )
  assert.deepEqual(await loadConfig(dir), {})
})

// Shipping a feature whose whole purpose is not leaving credentials readable, while the
// two-step password is echoed onto the screen two files away, would be incoherent.
test('the two-step password is asked for without echoing it', async () => {
  const configDir = await tempDir('login')
  const prompts = fakePrompts(['1234', 'hash', '+1555', '00000', 'my-2fa', ''])

  await runLogin({
    configDir,
    prompts,
    createClient: () => ({
      session: { save: () => 'saved-session' },
      start: async ({ phoneNumber, phoneCode, password }) => {
        await phoneNumber()
        await phoneCode()
        await password()
      },
      getMe: async () => ({ username: 'someone', firstName: 'Some' }),
      destroy: async () => {},
    }),
    log: () => {},
  })

  assert.equal(prompts.secretly.length, 1)
  assert.match(prompts.secretly[0], /Two-step password/)
})
