import test from 'node:test'
import assert from 'node:assert/strict'

import {
  newBackupId,
  chunkFileName,
  manifestFileName,
  buildManifest,
  serializeManifest,
  parseManifest,
  parseManifestJson,
  manifestMessageIds,
} from '../src/manifest.js'

function sampleChunks() {
  return [
    { i: 0, msgId: 1234, size: 40, sha256: 'a3f1' },
    { i: 1, msgId: 1235, size: 40, sha256: '9c20' },
    { i: 2, msgId: 1236, size: 20, sha256: '77bb' },
  ]
}

function sampleManifest(overrides = {}) {
  return buildManifest({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 100,
    chunkSize: 40,
    chunks: sampleChunks(),
    createdAt: '2026-09-05T07:40:12.000Z',
    ...overrides,
  })
}

test('newBackupId follows the telstore-YYYYMMDD-hex shape', () => {
  const id = newBackupId(new Date('2026-09-05T07:40:12.000Z'), () => '7f3a91')
  assert.equal(id, 'telstore-20260905-7f3a91')
})

test('newBackupId is genuinely random and well formed', () => {
  const a = newBackupId()
  const b = newBackupId()
  assert.match(a, /^telstore-\d{8}-[0-9a-f]{6}$/)
  assert.notEqual(a, b)
})

test('chunkFileName numbers from 1 and pads to four digits', () => {
  assert.equal(chunkFileName('telstore-1', 0), 'telstore-1.part0001')
  assert.equal(chunkFileName('telstore-1', 41), 'telstore-1.part0042')
  assert.equal(chunkFileName('telstore-1', 1233), 'telstore-1.part1234')
})

test('manifestFileName ends in .manifest.json', () => {
  assert.equal(manifestFileName('telstore-1'), 'telstore-1.manifest.json')
})

test('buildManifest stamps version 1 and orders the chunks', () => {
  const m = buildManifest({
    id: 'telstore-1',
    name: 'data.tar',
    size: 100,
    chunkSize: 40,
    chunks: [sampleChunks()[2], sampleChunks()[0], sampleChunks()[1]],
    createdAt: '2026-09-05T07:40:12.000Z',
  })

  assert.equal(m.v, 1)
  assert.deepEqual(m.chunks.map((c) => c.i), [0, 1, 2])
})

test('serialize then parse returns the original manifest', () => {
  const m = sampleManifest()
  assert.deepEqual(parseManifest(serializeManifest(m)), m)
})

test('parseManifest accepts both a string and a Buffer', () => {
  const m = sampleManifest()
  assert.deepEqual(parseManifest(serializeManifest(m).toString('utf8')), m)
})

test('parseManifest rejects an unknown version', () => {
  const m = { ...sampleManifest(), v: 2 }
  assert.throws(() => parseManifest(JSON.stringify(m)), /version/)
})

test('parseManifest detects a missing chunk', () => {
  const m = sampleManifest()
  m.chunks = m.chunks.slice(0, 2)
  assert.throws(() => parseManifest(JSON.stringify(m)), /missing/)
})

test('parseManifest detects a mismatched total size', () => {
  const m = sampleManifest()
  m.chunks[0].size = 39
  assert.throws(() => parseManifest(JSON.stringify(m)), /add up to/)
})

test('parseManifest rejects broken JSON', () => {
  assert.throws(() => parseManifest('{ broken'), /not valid JSON/)
})

test('parseManifest catches a skewed chunk layout even when the total is right', () => {
  // 1000 bytes at chunkSize 400 must be [400, 400, 200]. The set [200, 400, 400] has
  // the right total, the right count, contiguous i and matching per-chunk sha256 —
  // but restore writes chunk i at offset i*400, producing a 1200-byte file with a hole.
  const m = buildManifest({
    id: 'telstore-1',
    name: 'data.tar',
    size: 1000,
    chunkSize: 400,
    chunks: [
      { i: 0, msgId: 1, size: 200, sha256: 'a' },
      { i: 1, msgId: 2, size: 400, sha256: 'b' },
      { i: 2, msgId: 3, size: 400, sha256: 'c' },
    ],
    createdAt: '2026-09-05T07:40:12.000Z',
  })

  assert.throws(() => parseManifest(JSON.stringify(m)), /records 200 bytes for chunk 1.*400 bytes/s)
})

test('parseManifest catches a last chunk longer than the remainder', () => {
  const m = buildManifest({
    id: 'telstore-1',
    name: 'data.tar',
    size: 100,
    chunkSize: 40,
    chunks: [
      { i: 0, msgId: 1, size: 30, sha256: 'a' },
      { i: 1, msgId: 2, size: 30, sha256: 'b' },
      { i: 2, msgId: 3, size: 40, sha256: 'c' },
    ],
    createdAt: '2026-09-05T07:40:12.000Z',
  })

  assert.throws(() => parseManifest(JSON.stringify(m)), /wrong chunk positions/)
})

test('parseManifest accepts a correct uniform layout', () => {
  const m = buildManifest({
    id: 'telstore-1',
    name: 'data.tar',
    size: 1000,
    chunkSize: 400,
    chunks: [
      { i: 0, msgId: 1, size: 400, sha256: 'a' },
      { i: 1, msgId: 2, size: 400, sha256: 'b' },
      { i: 2, msgId: 3, size: 200, sha256: 'c' },
    ],
    createdAt: '2026-09-05T07:40:12.000Z',
  })

  assert.deepEqual(parseManifest(JSON.stringify(m)), m)
})

// The manifest is downloaded from a chat, so it is untrusted input. Every rejection has to
// name what is actually wrong with it: a raw TypeError tells the user their file is broken
// in a way only a developer can read.
test('parseManifest names a chunk entry that is not an object', () => {
  const text = JSON.stringify({
    v: 1,
    id: 'x',
    name: 'n',
    size: 100,
    chunkSize: 50,
    chunks: [{ i: 0, msgId: 1, size: 50, sha256: 'a' }, null],
  })

  assert.throws(() => parseManifest(text), /chunk 2 .*not|entry 2|is not an object/i)
})

// The old code compared a numeric total against a string size with !==, so it rejected the
// manifest — but the message read "Chunk sizes add up to 100, but the manifest records a
// file size of 100", which sends the reader hunting for a difference that is not there.
test('parseManifest says the size is the wrong type rather than printing it twice', () => {
  const text = JSON.stringify({
    v: 1,
    id: 'x',
    name: 'n',
    size: '100',
    chunkSize: 50,
    chunks: [
      { i: 0, msgId: 1, size: 50, sha256: 'a' },
      { i: 1, msgId: 2, size: 50, sha256: 'b' },
    ],
  })

  assert.throws(() => parseManifest(text), /whole number/)
})

test('parseManifest rejects a chunk size that is not a whole number', () => {
  const text = JSON.stringify({
    v: 1,
    id: 'x',
    name: 'n',
    size: 100,
    chunkSize: 0,
    chunks: [{ i: 0, msgId: 1, size: 100, sha256: 'a' }],
  })

  assert.throws(() => parseManifest(text), /whole number/)
})

test('parseManifestJson reads a manifest body without judging what is in it', () => {
  assert.deepEqual(parseManifestJson(Buffer.from('{"v":9,"chunks":[]}')), { v: 9, chunks: [] })
})

test('parseManifestJson refuses content that is not JSON', () => {
  assert.throws(() => parseManifestJson('{ not json'), /not valid JSON/)
})

// The test that proves delete does not go through parseManifest. A manifest whose layout
// is wrong is exactly the broken backup somebody wants gone; refusing to read its message
// ids would leave the only way out through the Telegram app.
test('manifestMessageIds reads a manifest that parseManifest would refuse', () => {
  const broken = { v: 2, size: 999, chunkSize: 1, chunks: [{ i: 0, msgId: 10, size: 7 }] }

  assert.throws(() => parseManifest(JSON.stringify(broken)))
  assert.deepEqual(manifestMessageIds(broken), [10])
})

test('manifestMessageIds returns the ids in the order the manifest lists them', () => {
  const manifest = { chunks: [{ msgId: 10 }, { msgId: 12 }, { msgId: 11 }] }

  assert.deepEqual(manifestMessageIds(manifest), [10, 12, 11])
})

test('manifestMessageIds refuses a manifest with no chunk list', () => {
  assert.throws(() => manifestMessageIds({ chunks: [] }), /cannot say which messages/)
  assert.throws(() => manifestMessageIds({}), /cannot say which messages/)
  assert.throws(() => manifestMessageIds({ chunks: 'nope' }), /cannot say which messages/)
})

// Which message to destroy is the one number nobody may guess at. A manifest that cannot
// say it exactly is refused whole, rather than half-deleted and then left without the list
// that names the rest.
test('manifestMessageIds refuses an id that is not a message id', () => {
  for (const msgId of [null, undefined, '12', 0, -3, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => manifestMessageIds({ chunks: [{ msgId: 10 }, { msgId }] }),
      /chunk 2/,
      `expected ${JSON.stringify(msgId)} to be refused`,
    )
  }
})

test('manifestMessageIds refuses a chunk entry that is not an object', () => {
  assert.throws(() => manifestMessageIds({ chunks: [null] }), /chunk 1/)
})
