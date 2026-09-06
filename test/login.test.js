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
    ask(question) {
      this.asked.push(question)
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

// GramJS starts an update loop on connect that runs until _destroyed is set, and only
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
