import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LIMIT,
  SETTING_KEYS,
  canonicalKey,
  isManagedByLogin,
  requireChat,
  resolveSettings,
} from '../src/settings.js'
import { DEFAULT_CHUNK_SIZE, DEFAULT_CONCURRENCY } from '../src/chunking.js'

const FILE = '/home/someone/.telark/config.json'

const resolve = (options, config) => resolveSettings(options, config, { file: FILE })

test('a flag beats a stored setting, which beats the built-in default', () => {
  const stored = { settings: { chat: '@stored', concurrency: 4 } }

  const { values, source } = resolve({ to: '@flag' }, stored)

  assert.equal(values.chat, '@flag')
  assert.equal(source('chat'), 'flag')

  assert.equal(values.concurrency, 4)
  assert.equal(source('concurrency'), 'settings')

  assert.equal(values.limit, DEFAULT_LIMIT)
  assert.equal(source('limit'), 'default')
})

test('an empty config resolves every key to its default', () => {
  const { values, source } = resolve({}, {})

  assert.equal(values.chat, null)
  assert.equal(values.chunkSize, DEFAULT_CHUNK_SIZE)
  assert.equal(values.concurrency, DEFAULT_CONCURRENCY)
  assert.equal(values.limit, DEFAULT_LIMIT)
  assert.equal(values.verbose, false)

  for (const key of SETTING_KEYS) assert.equal(source(key), 'default')
})

// A misspelt key at the upload call site would turn "refuse to resume at a different chunk
// size" into "resume at a different chunk size", silently. That is the one outcome this
// project may never produce, so an unknown key is an error rather than undefined.
test('source refuses a key it does not know instead of returning nothing', () => {
  const { source } = resolve({}, {})

  assert.throws(() => source('chunksize'), /Unknown setting: chunksize/)
  assert.throws(() => source('chunksize'), /chunkSize/)
})

test('a size is parsed the same whether it arrives as a flag or from the file', () => {
  assert.equal(resolve({ 'chunk-size': '500MB' }, {}).values.chunkSize, 500 * 1024 * 1024)
  assert.equal(
    resolve({}, { settings: { chunkSize: 500 * 1024 * 1024 } }).values.chunkSize,
    500 * 1024 * 1024,
  )
})

test('a stored value that cannot be used names the file, never a flag nobody typed', () => {
  assert.throws(
    () => resolve({}, { settings: { concurrency: 0 } }),
    (err) => {
      assert.match(err.message, /concurrency in \/home\/someone\/\.telark\/config\.json/)
      assert.doesNotMatch(err.message, /--concurrency/)
      return true
    },
  )
})

test('a bad flag still names the flag', () => {
  assert.throws(() => resolve({ concurrency: '0' }, {}), /Invalid --concurrency: "0"/)
  assert.throws(() => resolve({ limit: 'lots' }, {}), /Invalid --limit: "lots"/)
  assert.throws(() => resolve({ 'chunk-size': '9GB' }, {}), /Invalid --chunk-size: "9GB"/)
})

test('a stored setting of the wrong JSON type is refused, not coerced', () => {
  assert.throws(() => resolve({}, { settings: { chat: true } }), /Invalid chat in/)
  assert.throws(() => resolve({}, { settings: { chat: 42.5 } }), /Invalid chat in/)
  assert.throws(() => resolve({}, { settings: { concurrency: [] } }), /Invalid concurrency in/)
  assert.throws(() => resolve({}, { settings: { verbose: 'yes' } }), /Invalid verbose in/)
})

test('verbose reads both the flag and the word stored in the file', () => {
  assert.equal(resolve({ verbose: true }, {}).values.verbose, true)
  assert.equal(resolve({}, { settings: { verbose: true } }).values.verbose, true)
  assert.equal(resolve({}, { settings: { verbose: false } }).values.verbose, false)
  assert.equal(resolve({}, { settings: { verbose: 'true' } }).values.verbose, true)
})

test('a stored destination is normalised the way a typed one is', () => {
  assert.equal(resolve({}, { settings: { chat: '  -1001234567890  ' } }).values.chat, -1001234567890)
  assert.equal(resolve({}, { settings: { chat: 'me' } }).values.chat, 'me')
})

test('requireChat points at config, and offers the flag as the one-run alternative', () => {
  assert.throws(() => requireChat(resolve({}, {}).values), (err) => {
    assert.match(err.message, /telark config chat/)
    assert.match(err.message, /--to/)
    assert.doesNotMatch(err.message, /remember/)
    return true
  })

  assert.equal(requireChat(resolve({ to: '@x' }, {}).values), '@x')
})

test('the flag spelling of a key is accepted as a way in, and canonicalised', () => {
  assert.equal(canonicalKey('chunk-size'), 'chunkSize')
  assert.equal(canonicalKey('chunkSize'), 'chunkSize')
  assert.equal(canonicalKey('CHUNKSIZE'), 'chunkSize')
  assert.equal(canonicalKey('to'), 'chat')
  assert.equal(canonicalKey('nonsense'), null)
})

test('credentials are named as login business, not as a misspelt setting', () => {
  assert.equal(isManagedByLogin('session'), true)
  assert.equal(isManagedByLogin('apiId'), true)
  assert.equal(isManagedByLogin('chat'), false)
})
