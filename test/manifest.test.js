import test from 'node:test'
import assert from 'node:assert/strict'

import {
  newBackupId,
  chunkFileName,
  manifestFileName,
  buildManifest,
  serializeManifest,
  parseManifest,
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
    id: 'ark-20260905-7f3a91',
    name: 'data.tar',
    size: 100,
    chunkSize: 40,
    chunks: sampleChunks(),
    createdAt: '2026-09-05T07:40:12.000Z',
    ...overrides,
  })
}

test('newBackupId follows the ark-YYYYMMDD-hex shape', () => {
  const id = newBackupId(new Date('2026-09-05T07:40:12.000Z'), () => '7f3a91')
  assert.equal(id, 'ark-20260905-7f3a91')
})

test('newBackupId is genuinely random and well formed', () => {
  const a = newBackupId()
  const b = newBackupId()
  assert.match(a, /^ark-\d{8}-[0-9a-f]{6}$/)
  assert.notEqual(a, b)
})

test('chunkFileName numbers from 1 and pads to four digits', () => {
  assert.equal(chunkFileName('ark-1', 0), 'ark-1.part0001')
  assert.equal(chunkFileName('ark-1', 41), 'ark-1.part0042')
  assert.equal(chunkFileName('ark-1', 1233), 'ark-1.part1234')
})

test('manifestFileName ends in .manifest.json', () => {
  assert.equal(manifestFileName('ark-1'), 'ark-1.manifest.json')
})

test('buildManifest stamps version 1 and orders the chunks', () => {
  const m = buildManifest({
    id: 'ark-1',
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
    id: 'ark-1',
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
    id: 'ark-1',
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
    id: 'ark-1',
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
