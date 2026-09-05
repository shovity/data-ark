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

test('newBackupId theo đúng khuôn ark-YYYYMMDD-hex', () => {
  const id = newBackupId(new Date('2026-09-05T07:40:12.000Z'), () => '7f3a91')
  assert.equal(id, 'ark-20260905-7f3a91')
})

test('newBackupId thật sự ngẫu nhiên và đúng khuôn', () => {
  const a = newBackupId()
  const b = newBackupId()
  assert.match(a, /^ark-\d{8}-[0-9a-f]{6}$/)
  assert.notEqual(a, b)
})

test('chunkFileName đánh số từ 1 và đệm bốn chữ số', () => {
  assert.equal(chunkFileName('ark-1', 0), 'ark-1.part0001')
  assert.equal(chunkFileName('ark-1', 41), 'ark-1.part0042')
  assert.equal(chunkFileName('ark-1', 1233), 'ark-1.part1234')
})

test('manifestFileName kết thúc bằng .manifest.json', () => {
  assert.equal(manifestFileName('ark-1'), 'ark-1.manifest.json')
})

test('buildManifest gắn phiên bản 1 và sắp chunk theo thứ tự', () => {
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

test('serialize rồi parse thì ra đúng manifest ban đầu', () => {
  const m = sampleManifest()
  assert.deepEqual(parseManifest(serializeManifest(m)), m)
})

test('parseManifest nhận cả chuỗi lẫn Buffer', () => {
  const m = sampleManifest()
  assert.deepEqual(parseManifest(serializeManifest(m).toString('utf8')), m)
})

test('parseManifest từ chối phiên bản lạ', () => {
  const m = { ...sampleManifest(), v: 2 }
  assert.throws(() => parseManifest(JSON.stringify(m)), /phiên bản/)
})

test('parseManifest phát hiện thiếu chunk', () => {
  const m = sampleManifest()
  m.chunks = m.chunks.slice(0, 2)
  assert.throws(() => parseManifest(JSON.stringify(m)), /thiếu/)
})

test('parseManifest phát hiện tổng size lệch', () => {
  const m = sampleManifest()
  m.chunks[0].size = 39
  assert.throws(() => parseManifest(JSON.stringify(m)), /không khớp/)
})

test('parseManifest từ chối JSON hỏng', () => {
  assert.throws(() => parseManifest('{ hỏng'), /đọc được/)
})

test('parseManifest bắt bố cục chunk lệch dù tổng size vẫn đúng', () => {
  // 1000 byte, chunkSize 400 → phải là [400, 400, 200]. Bộ [200, 400, 400] có
  // tổng đúng, số chunk đúng, i liên tục, sha256 từng chunk khớp — nhưng restore
  // ghi chunk i vào offset i*400 nên sẽ tạo ra file 1200 byte thủng lỗ.
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

  assert.throws(() => parseManifest(JSON.stringify(m)), /Chunk 1 .*200 byte.*400 byte/s)
})

test('parseManifest bắt chunk cuối dài hơn phần dư', () => {
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

  assert.throws(() => parseManifest(JSON.stringify(m)), /sai vị trí các chunk/)
})

test('parseManifest chấp nhận bố cục đều đúng chuẩn', () => {
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
