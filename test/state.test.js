import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { stateKey, loadState, saveState, markChunkDone, clearState, stateDir } from '../src/state.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-state-'))
}

function sampleState(overrides = {}) {
  return {
    id: 'ark-20260905-7f3a91',
    chat: '@kho_backup',
    path: '/home/ai/data.tar',
    size: 100,
    mtimeMs: 1757000000000,
    chunkSize: 40,
    done: {},
    ...overrides,
  }
}

test('stateKey ổn định giữa các lần gọi', () => {
  const a = stateKey('/home/ai/data.tar', 100, 1757000000000)
  const b = stateKey('/home/ai/data.tar', 100, 1757000000000)
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{40}$/)
})

test('stateKey đổi khi file bị sửa', () => {
  const goc = stateKey('/home/ai/data.tar', 100, 1757000000000)
  assert.notEqual(stateKey('/home/ai/data.tar', 101, 1757000000000), goc)
  assert.notEqual(stateKey('/home/ai/data.tar', 100, 1757000000001), goc)
  assert.notEqual(stateKey('/home/ai/khac.tar', 100, 1757000000000), goc)
})

test('stateDir nằm dưới thư mục cấu hình', async () => {
  const dir = await tempDir()
  assert.equal(stateDir(dir), path.join(dir, 'state'))
})

test('loadState trả null khi chưa có gì', async () => {
  const dir = await tempDir()
  assert.equal(await loadState('khong-co', dir), null)
})

test('saveState rồi loadState lấy lại đúng dữ liệu', async () => {
  const dir = await tempDir()
  const state = sampleState()

  await saveState('k1', state, dir)

  assert.deepEqual(await loadState('k1', dir), state)
})

test('markChunkDone ghi lại tiến độ ngay lập tức', async () => {
  const dir = await tempDir()
  const state = sampleState()
  await saveState('k1', state, dir)

  const updated = await markChunkDone('k1', state, 0, { msgId: 1234, size: 40, sha256: 'a3f1' }, dir)

  assert.deepEqual(updated.done['0'], { msgId: 1234, size: 40, sha256: 'a3f1' })
  assert.deepEqual((await loadState('k1', dir)).done['0'], { msgId: 1234, size: 40, sha256: 'a3f1' })
})

test('markChunkDone tích luỹ chứ không ghi đè chunk trước', async () => {
  const dir = await tempDir()
  let state = sampleState()
  await saveState('k1', state, dir)

  state = await markChunkDone('k1', state, 0, { msgId: 1, size: 40, sha256: 'aa' }, dir)
  state = await markChunkDone('k1', state, 1, { msgId: 2, size: 40, sha256: 'bb' }, dir)

  const onDisk = await loadState('k1', dir)
  assert.deepEqual(Object.keys(onDisk.done).sort(), ['0', '1'])
})

test('saveState không để lại file tạm', async () => {
  const dir = await tempDir()

  await saveState('k1', sampleState(), dir)

  assert.deepEqual(await fs.readdir(stateDir(dir)), ['k1.json'])
})

test('clearState xoá state và không kêu ca nếu đã bị xoá', async () => {
  const dir = await tempDir()
  await saveState('k1', sampleState(), dir)

  await clearState('k1', dir)
  await clearState('k1', dir)

  assert.equal(await loadState('k1', dir), null)
})
