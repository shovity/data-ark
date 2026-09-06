import test from 'node:test'
import assert from 'node:assert/strict'

import { LogLevel } from 'telegram/extensions/Logger.js'

import { assertLoggedIn, createLogger } from '../src/client.js'

test('assertLoggedIn throws on an empty config', () => {
  assert.throws(() => assertLoggedIn({}), /Not logged in/)
})

test('assertLoggedIn throws when apiHash is missing', () => {
  assert.throws(() => assertLoggedIn({ session: 's', apiId: 1 }), /Not logged in/)
})

test('assertLoggedIn does not throw on a complete config', () => {
  assert.doesNotThrow(() => assertLoggedIn({ session: 's', apiId: 1, apiHash: 'h' }))
})

test('the Telegram logger is silent unless --verbose is given', () => {
  const quiet = createLogger(false)
  assert.equal(quiet.canSend(LogLevel.INFO), false)
  assert.equal(quiet.canSend(LogLevel.WARN), false)

  const loud = createLogger(true)
  assert.equal(loud.canSend(LogLevel.INFO), true)
  assert.equal(loud.canSend(LogLevel.WARN), true)
})
