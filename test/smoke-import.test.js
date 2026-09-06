import test from 'node:test'
import assert from 'node:assert/strict'

import { Api, TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { readBigIntFromBuffer } from 'telegram/Helpers.js'

test('the GramJS pieces we depend on can be imported', () => {
  assert.equal(typeof TelegramClient, 'function')
  assert.equal(typeof StringSession, 'function')
  assert.equal(typeof readBigIntFromBuffer, 'function')
  assert.equal(typeof Api.upload.SaveBigFilePart, 'function')
  assert.equal(typeof Api.InputFileBig, 'function')
})

// list and restore search the chat through these two, and the fake clients the rest of
// the suite talks to would happily accept a name GramJS does not have.
test('the GramJS pieces list and restore search with can be imported', () => {
  assert.equal(typeof Api.InputMessagesFilterDocument, 'function')
  assert.equal(typeof Api.DocumentAttributeFilename, 'function')
})

// delete hands ids to GramJS's own deleteMessages, which resolves the peer and picks
// between the two request types below. The fake client the rest of the suite talks to
// would accept a method name GramJS does not have.
test('the GramJS pieces delete removes messages with can be imported', () => {
  assert.equal(typeof TelegramClient.prototype.deleteMessages, 'function')
  assert.equal(typeof Api.messages.DeleteMessages, 'function')
  assert.equal(typeof Api.channels.DeleteMessages, 'function')
})

// Not decoration: GramJS destructures the third argument with no default of its own, so
// calling it with two arguments throws a TypeError before anything reaches the network.
// The arity is what says that object is required.
test('GramJS deleteMessages takes the options object data-ark passes', () => {
  assert.equal(TelegramClient.prototype.deleteMessages.length, 3)
})
