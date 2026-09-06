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
  pruneStates,
  MAX_STATES,
  findStates,
} from '../src/state.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'telstore-state-'))
}

function sampleState(overrides = {}) {
  return {
    id: 'telstore-20260905-7f3a91',
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
  await saveState('aaa', sampleState({ id: 'telstore-1' }), dir)
  await saveState('bbb', sampleState({ id: 'telstore-2', path: '/home/ai/vm.qcow2' }), dir)
  await fs.writeFile(path.join(stateDir(dir), 'ccc.json'), '{ not json')

  const states = await listStates(dir)

  assert.deepEqual(
    states.map((s) => s.id).sort(),
    ['telstore-1', 'telstore-2'],
  )
})

test('listStates on a machine that has never run an upload returns nothing', async () => {
  assert.deepEqual(await listStates(await tempDir()), [])
})

// Every state file is written the moment a chunk lands, so the file's own mtime is the
// last time this backup made progress. Tests set it explicitly rather than racing the clock.
async function saveStateAged(key, state, dir, ageMinutes) {
  await saveState(key, state, dir)
  const when = new Date(Date.UTC(2026, 8, 5) - ageMinutes * 60_000)
  await fs.utimes(path.join(stateDir(dir), `${key}.json`), when, when)
}

test('pruneStates keeps the newest states and drops the older ones', async () => {
  const dir = await tempDir()
  await saveStateAged('old', sampleState({ id: 'telstore-old' }), dir, 300)
  await saveStateAged('mid', sampleState({ id: 'telstore-mid' }), dir, 200)
  await saveStateAged('new', sampleState({ id: 'telstore-new' }), dir, 100)

  await pruneStates(dir, 2)

  const left = await listStates(dir)
  assert.deepEqual(left.map((s) => s.id).sort(), ['telstore-mid', 'telstore-new'])
})

test('pruneStates names the backups it dropped', async () => {
  const dir = await tempDir()
  await saveStateAged('old', sampleState({ id: 'telstore-old' }), dir, 300)
  await saveStateAged('new', sampleState({ id: 'telstore-new' }), dir, 100)

  const dropped = await pruneStates(dir, 1)

  assert.deepEqual(dropped.map((s) => s.id), ['telstore-old'])
})

test('pruneStates below the limit changes nothing', async () => {
  const dir = await tempDir()
  await saveStateAged('a', sampleState({ id: 'telstore-1' }), dir, 200)
  await saveStateAged('b', sampleState({ id: 'telstore-2' }), dir, 100)

  assert.deepEqual(await pruneStates(dir, 20), [])
  assert.equal((await listStates(dir)).length, 2)
})

test('pruneStates deletes an unreadable state file without naming it', async () => {
  const dir = await tempDir()
  await saveStateAged('good', sampleState({ id: 'telstore-good' }), dir, 100)
  await fs.writeFile(path.join(stateDir(dir), 'broken.json'), '{ not json')
  const old = new Date(Date.UTC(2026, 8, 5) - 300 * 60_000)
  await fs.utimes(path.join(stateDir(dir), 'broken.json'), old, old)

  const dropped = await pruneStates(dir, 1)

  assert.deepEqual(dropped, [])
  assert.deepEqual(await fs.readdir(stateDir(dir)), ['good.json'])
})

test('pruneStates on a machine that has never run an upload does nothing', async () => {
  assert.deepEqual(await pruneStates(await tempDir()), [])
})

test('the default limit is 20 unfinished backups', () => {
  assert.equal(MAX_STATES, 20)
})

test('findStates returns the record of a backup together with the file it came from', async () => {
  const dir = await tempDir()
  await saveState('abc123', sampleState({ id: 'telstore-wanted' }), dir)
  await saveState('def456', sampleState({ id: 'telstore-other' }), dir)

  const found = await findStates('telstore-wanted', dir)

  assert.equal(found.length, 1)
  assert.equal(found[0].key, 'abc123')
  assert.equal(found[0].file, path.join(stateDir(dir), 'abc123.json'))
  assert.equal(found[0].state.id, 'telstore-wanted')
})

// The key is a hash of the path, size and mtime *inside* the record, so recomputing it
// would trust an untrusted file to say where it lives. A hand-edited path yields a key
// naming no file at all, and clearState ignores a file that is not there — telstore would
// report a record dropped that is still sitting on disk.
test('findStates reports the real file name even when the record disagrees with it', async () => {
  const dir = await tempDir()
  await saveState('handpicked', sampleState({ id: 'telstore-wanted', path: '/somewhere/else' }), dir)

  const [found] = await findStates('telstore-wanted', dir)

  assert.equal(found.key, 'handpicked')
})

test('findStates returns every record claiming the same backup id', async () => {
  const dir = await tempDir()
  await saveState('one', sampleState({ id: 'telstore-twin' }), dir)
  await saveState('two', sampleState({ id: 'telstore-twin', path: '/other.tar' }), dir)

  assert.equal((await findStates('telstore-twin', dir)).length, 2)
})

test('findStates skips a state file that cannot be read instead of failing', async () => {
  const dir = await tempDir()
  await saveState('good', sampleState({ id: 'telstore-wanted' }), dir)
  await fs.writeFile(path.join(stateDir(dir), 'broken.json'), '{ not json')

  assert.equal((await findStates('telstore-wanted', dir)).length, 1)
})

test('findStates on a machine that has never run an upload finds nothing', async () => {
  assert.deepEqual(await findStates('telstore-wanted', await tempDir()), [])
})
