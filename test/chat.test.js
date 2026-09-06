import test from 'node:test'
import assert from 'node:assert/strict'

import { chatName, chatUrl, describeChat, normalizeChatTarget } from '../src/chat.js'

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

test('a chat target becomes a clickable web.telegram.org link', () => {
  assert.equal(chatUrl('-5107543795'), 'https://web.telegram.org/k/#-5107543795')
  assert.equal(chatUrl(-5107543795), 'https://web.telegram.org/k/#-5107543795')
  assert.equal(chatUrl('@my_backups'), 'https://web.telegram.org/k/#@my_backups')
})

test('Saved Messages has no stable link, so it gets none', () => {
  assert.equal(chatUrl('me'), null)
})

test('Saved Messages is named rather than shown as a target', () => {
  assert.equal(chatName('me'), 'Saved Messages')
  assert.equal(chatName('@my_backups'), '@my_backups')
})

test('a destination is described as a link, or named when it has none', () => {
  assert.equal(describeChat('@my_backups'), 'https://web.telegram.org/k/#@my_backups')
  assert.equal(describeChat('me'), 'me (Saved Messages)')
})
