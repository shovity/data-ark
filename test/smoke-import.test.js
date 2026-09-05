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
