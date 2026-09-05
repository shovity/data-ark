import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  stateKey,
  loadState,
  saveState,
  markChunkDone,
  clearState,
  stateDir,
  listStates,
} from '../src/state.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-state-'))
}

function sampleState(overrides = {}) {
  return {
    id: 'ark-20260905-7f3a91',
    chat: '@my_backups',
    path: '/home/ai/data.tar',
    size: 100,
    mtimeMs: 1757000000000,
    chunkSize: 40,
    done: {},
    ...overrides,
  }
}

test('stateKey is stable across calls', () => {
  const a = stateKey('/home/ai/data.tar', 100, 1757000000000)
  const b = stateKey('/home/ai/data.tar', 100, 1757000000000)
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{40}$/)
})

test('stateKey changes when the file changes', () => {
  const original = stateKey('/home/ai/data.tar', 100, 1757000000000)
  assert.notEqual(stateKey('/home/ai/data.tar', 101, 1757000000000), original)
  assert.notEqual(stateKey('/home/ai/data.tar', 100, 1757000000001), original)
  assert.notEqual(stateKey('/home/ai/other.tar', 100, 1757000000000), original)
})

test('stateDir lives under the config directory', async () => {
  const dir = await tempDir()
  assert.equal(stateDir(dir), path.join(dir, 'state'))
})

test('loadState returns null when nothing is stored', async () => {
  const dir = await tempDir()
  assert.equal(await loadState('missing', dir), null)
})

test('saveState then loadState round-trips the data', async () => {
  const dir = await tempDir()
  const state = sampleState()

  await saveState('k1', state, dir)

  assert.deepEqual(await loadState('k1', dir), state)
})

test('markChunkDone persists progress immediately', async () => {
  const dir = await tempDir()
  const state = sampleState()
  await saveState('k1', state, dir)

  const updated = await markChunkDone('k1', state, 0, { msgId: 1234, size: 40, sha256: 'a3f1' }, dir)

  assert.deepEqual(updated.done['0'], { msgId: 1234, size: 40, sha256: 'a3f1' })
  assert.deepEqual((await loadState('k1', dir)).done['0'], { msgId: 1234, size: 40, sha256: 'a3f1' })
})

test('markChunkDone accumulates instead of overwriting earlier chunks', async () => {
  const dir = await tempDir()
  let state = sampleState()
  await saveState('k1', state, dir)

  state = await markChunkDone('k1', state, 0, { msgId: 1, size: 40, sha256: 'aa' }, dir)
  state = await markChunkDone('k1', state, 1, { msgId: 2, size: 40, sha256: 'bb' }, dir)

  const onDisk = await loadState('k1', dir)
  assert.deepEqual(Object.keys(onDisk.done).sort(), ['0', '1'])
})

test('saveState leaves no temporary file behind', async () => {
  const dir = await tempDir()

  await saveState('k1', sampleState(), dir)

  assert.deepEqual(await fs.readdir(stateDir(dir)), ['k1.json'])
})

test('clearState removes the state and stays quiet if it is already gone', async () => {
  const dir = await tempDir()
  await saveState('k1', sampleState(), dir)

  await clearState('k1', dir)
  await clearState('k1', dir)

  assert.equal(await loadState('k1', dir), null)
})

test('listStates returns every unfinished backup and skips unreadable files', async () => {
  const dir = await tempDir()
  await saveState('aaa', sampleState({ id: 'ark-1' }), dir)
  await saveState('bbb', sampleState({ id: 'ark-2', path: '/home/ai/vm.qcow2' }), dir)
  await fs.writeFile(path.join(stateDir(dir), 'ccc.json'), '{ not json')

  const states = await listStates(dir)

  assert.deepEqual(
    states.map((s) => s.id).sort(),
    ['ark-1', 'ark-2'],
  )
})

test('listStates on a machine that has never run an upload returns nothing', async () => {
  assert.deepEqual(await listStates(await tempDir()), [])
})
