import test from 'node:test'
import assert from 'node:assert/strict'

import { Api, TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { readBigIntFromBuffer } from 'telegram/Helpers.js'

test('import được các thành phần GramJS cần dùng', () => {
  assert.equal(typeof TelegramClient, 'function')
  assert.equal(typeof StringSession, 'function')
  assert.equal(typeof readBigIntFromBuffer, 'function')
  assert.equal(typeof Api.upload.SaveBigFilePart, 'function')
  assert.equal(typeof Api.InputFileBig, 'function')
})
