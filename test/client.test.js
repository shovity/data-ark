import test from 'node:test'
import assert from 'node:assert/strict'

import { LogLevel } from 'telegram/extensions/Logger.js'

import {
  normalizeChatTarget,
  requireChat,
  assertLoggedIn,
  createLogger,
  chatUrl,
} from '../src/client.js'

test('me is left untouched', () => {
  assert.equal(normalizeChatTarget('me'), 'me')
})

test('a username stays a string', () => {
  assert.equal(normalizeChatTarget('@my_backups'), '@my_backups')
})

test('a channel id becomes a number', () => {
  assert.equal(normalizeChatTarget('-1001234567890'), -1001234567890)
  assert.equal(normalizeChatTarget('123456'), 123456)
})

test('surrounding whitespace is trimmed', () => {
  assert.equal(normalizeChatTarget('  @store  '), '@store')
})

test('an empty string is rejected', () => {
  assert.throws(() => normalizeChatTarget('   '), /must not be empty/)
})

test('requireChat prefers --to over the config', () => {
  assert.equal(requireChat({ to: '@new' }, { defaultChat: '@old' }), '@new')
})

test('requireChat uses the remembered destination when --to is absent', () => {
  assert.equal(requireChat({}, { defaultChat: '@old' }), '@old')
})

test('requireChat gives directions when no destination was ever set', () => {
  assert.throws(() => requireChat({}, {}), /--to/)
})

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

test('a chat target becomes a clickable web.telegram.org link', () => {
  assert.equal(chatUrl('-5107543795'), 'https://web.telegram.org/k/#-5107543795')
  assert.equal(chatUrl(-5107543795), 'https://web.telegram.org/k/#-5107543795')
  assert.equal(chatUrl('@my_backups'), 'https://web.telegram.org/k/#@my_backups')
})

test('Saved Messages has no stable link, so it gets none', () => {
  assert.equal(chatUrl('me'), null)
})
