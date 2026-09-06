import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { runUpload } from '../src/commands/upload.js'
import { parseManifestCaption } from '../src/caption.js'
import { parseManifest } from '../src/manifest.js'
import { saveConfig } from '../src/config.js'
import { loadState, stateFile, stateKey, MAX_STATES } from '../src/state.js'

import { fakeClient, tempDir, uploadDeps } from './helpers.js'

async function tempWorkspace(fileSize) {
  const dir = await tempDir('upload-cmd')
  const filePath = path.join(dir, 'data.tar')
  const content = randomBytes(fileSize)
  await fs.writeFile(filePath, content)
  return { dir, filePath, content, configDir: path.join(dir, 'config') }
}

const deps = uploadDeps

test('splits the file into the right number of chunks and uploads them all', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400', 'upload-concurrency': '2' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(result.chunks, 3)
  assert.match(result.id, /^telstore-\d{8}-[0-9a-f]{6}$/)

  const chunkMessages = client.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.equal(chunkMessages.length, 3)
  assert.deepEqual(Buffer.concat(chunkMessages.map((m) => m.bytes)), ws.content)
})

test('chunks are named and captioned after the backup id', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  const first = client.messages[0]
  assert.equal(first.fileName, `${result.id}.part0001`)
  assert.equal(first.caption, `\u{1F4E6} ${result.id} \u00B7 1/3`)
})

test('the manifest carries the summary card someone reads in the chat', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  const card = parseManifestCaption(client.messages.at(-1).caption)

  assert.equal(card.id, result.id)
  assert.equal(card.name, path.basename(ws.filePath))
  assert.equal(card.chunks, 3)
  assert.equal(card.size, '1000 B')
})

// list finds manifests by searching for the tag, so a chunk that carried it too would
// turn every backup into as many hits as it has chunks.
test('only the manifest carries the search tag', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  const tagged = client.messages.filter((m) => m.caption.includes('#telstore'))

  assert.equal(tagged.length, 1)
  assert.equal(tagged[0].fileName.endsWith('.manifest.json'), true)
})

test('the manifest is sent last and describes the chunks correctly', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  const last = client.messages.at(-1)
  assert.equal(last.fileName, `${result.id}.manifest.json`)

  const manifest = parseManifest(last.bytes)
  assert.equal(manifest.id, result.id)
  assert.equal(manifest.name, 'data.tar')
  assert.equal(manifest.size, 1000)
  assert.equal(manifest.chunks.length, 3)

  const chunkMessages = client.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.deepEqual(manifest.chunks.map((c) => c.msgId), chunkMessages.map((m) => m.id))
  assert.equal(
    manifest.chunks[0].sha256,
    createHash('sha256').update(ws.content.subarray(0, 400)).digest('hex'),
  )
})

test('--to is used for this run and saves nothing', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  await runUpload(
    ws.filePath,
    { to: '@new_store', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(client.messages[0].peer, '@new_store')
  await assert.rejects(
    () => fs.readFile(path.join(ws.configDir, 'config.json'), 'utf8'),
    { code: 'ENOENT' },
    'an upload must not write a destination the user only borrowed for one run',
  )
})

test('a configured destination is used when no --to is given', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  await saveConfig({ settings: { chat: '@stored_store' } }, ws.configDir)

  await runUpload(
    ws.filePath,
    { 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(client.messages[0].peer, '@stored_store')
})

test('no --to and no destination ever set gives a directive error', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(ws.filePath, {}, { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true }),
    /--to/,
  )
})

test('a nonexistent file gives a clear error', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(path.join(ws.dir, 'no-such-file.tar'), { to: '@store' }, {
        ...deps(client),
        configDir: ws.configDir,
        silent: true,
      }),
    /does not exist/,
  )
})

test('the state survives a mid-transfer failure', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient({ failOnChunk: 1 })

  await assert.rejects(
    () =>
      runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
        ...deps(client),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    /connection dropped/,
  )

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const state = await loadState(key, ws.configDir)

  assert.ok(state, 'the state must survive so the next run can resume')
  assert.deepEqual(Object.keys(state.done), ['0'])
})

test('rerunning after a failure skips finished chunks and keeps the backup id', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )
  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const firstRunId = (await loadState(key, ws.configDir)).id

  const retry = fakeClient()
  const result = await runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
    ...deps(retry),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  assert.equal(result.id, firstRunId)

  const chunkMessages = retry.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.equal(chunkMessages.length, 2, 'only the 2 missing chunks are re-uploaded')

  const manifest = parseManifest(retry.messages.at(-1).bytes)
  assert.equal(manifest.chunks.length, 3, 'the manifest still describes all 3 chunks')
})

test('a finished upload clears the state', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
    ...deps(client),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  assert.equal(await loadState(key, ws.configDir), null)
})

test('a non-numeric --upload-concurrency gives a clear error', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@store', 'chunk-size': '400', 'upload-concurrency': 'abc' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    /--upload-concurrency/,
  )
})

test('--upload-concurrency of 0 gives a clear error instead of hanging forever', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@store', 'chunk-size': '400', 'upload-concurrency': '0' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    /--upload-concurrency/,
  )
})

test('resuming with a different --to is blocked, no backup split across two destinations', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const retry = fakeClient()
  await assert.rejects(
    () =>
      runUpload(ws.filePath, { to: '@other_store', 'chunk-size': '400' }, {
        ...deps(retry),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    (err) => {
      assert.match(err.message, /@other_store/)
      assert.match(err.message, /--to @store/, 'the way back is the chat itself, not a flag to drop')
      assert.match(err.message, /\.json/)
      return true
    },
  )

  assert.equal(retry.messages.length, 0, 'nothing may be sent once the run is blocked')
})

// The advice in that message has to work for someone who never typed a flag: the mismatch
// is just as reachable from a configured destination, and "run again without --to" would
// leave them with nothing to drop.
test('a configured destination that disagrees with the backup is blocked the same way', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  await saveConfig({ settings: { chat: '@other_store' } }, ws.configDir)

  const retry = fakeClient()
  await assert.rejects(
    () =>
      runUpload(ws.filePath, {}, {
        ...deps(retry),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    /--to @store/,
  )

  assert.equal(retry.messages.length, 0)
})

test('an unfinished backup resumes with the chunk size it started with', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const firstRunId = (await loadState(key, ws.configDir)).id

  // No --chunk-size this time: the default is 1800MB, which would make this one chunk
  // and throw away the chunk already in the chat.
  const retry = fakeClient()
  const result = await runUpload(ws.filePath, { to: '@store' }, {
    ...deps(retry),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  assert.equal(result.id, firstRunId, 'the same backup must carry on')
  assert.equal(result.chunks, 3)

  const chunkMessages = retry.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.equal(chunkMessages.length, 2, 'the chunk that already landed is not sent twice')
})

test('changing --chunk-size on an unfinished backup is refused, not silently restarted', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const before = await loadState(key, ws.configDir)

  const retry = fakeClient()
  await assert.rejects(
    () =>
      runUpload(ws.filePath, { to: '@store', 'chunk-size': '250' }, {
        ...deps(retry),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    (err) => {
      assert.match(err.message, /--chunk-size/)
      assert.match(err.message, /\.json/)
      return true
    },
  )

  assert.equal(retry.messages.length, 0, 'nothing may be sent once the run is blocked')
  assert.deepEqual(await loadState(key, ws.configDir), before, 'the unfinished backup stays intact')
})

// A stored chunkSize is what to use when nobody asks for anything; it is not somebody
// asking. Refusing to resume over a preference set weeks ago for other files would strand
// the chunks already in the chat, which is the exact outcome the refusal exists to prevent.
test('a configured chunk size lets an unfinished backup carry on at its own size', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const firstRunId = (await loadState(key, ws.configDir)).id

  await saveConfig({ settings: { chat: '@store', chunkSize: 250 } }, ws.configDir)

  const retry = fakeClient()
  const result = await runUpload(ws.filePath, {}, {
    ...deps(retry),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  assert.equal(result.id, firstRunId, 'the same backup must carry on')
  assert.equal(result.chunks, 3, 'at 400 bytes a chunk, the size it started with')

  const chunkMessages = retry.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.equal(chunkMessages.length, 2, 'the chunk that already landed is not sent twice')
})

// ...but the same value typed on the command line is a request, and a request that cannot
// be honoured is refused rather than quietly ignored.
test('the same disagreement typed as a flag is still refused', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  await saveConfig({ settings: { chat: '@store', chunkSize: 250 } }, ws.configDir)

  const retry = fakeClient()
  await assert.rejects(
    () =>
      runUpload(ws.filePath, { 'chunk-size': '250' }, {
        ...deps(retry),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    /--chunk-size/,
  )

  assert.equal(retry.messages.length, 0)
})

test('the chunk size the backup started with may be repeated on the command line', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const retry = fakeClient()
  const result = await runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
    ...deps(retry),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  assert.equal(result.chunks, 3)
})

test('the backup id is announced before the first chunk goes out', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()
  const announced = []

  const result = await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    {
      ...deps(client),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
      onBackupId: (id) => announced.push({ id, sent: client.messages.length }),
    },
  )

  assert.deepEqual(announced, [{ id: result.id, sent: 0 }])
})

test('a resumed backup announces the id it is carrying on with', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const firstRunId = (await loadState(key, ws.configDir)).id

  const announced = []
  await runUpload(ws.filePath, { to: '@store' }, {
    ...deps(fakeClient()),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
    onBackupId: (id) => announced.push(id),
  })

  assert.deepEqual(announced, [firstRunId])
})

test('starting a new backup drops the oldest states past the limit and says which', async () => {
  const ws = await tempWorkspace(1000)
  const warnings = []

  const stateDirPath = path.join(ws.configDir, 'state')
  await fs.mkdir(stateDirPath, { recursive: true })

  for (let i = 0; i < MAX_STATES; i += 1) {
    const file = path.join(stateDirPath, `stale${i}.json`)
    const stale = {
      id: `telstore-stale-${i}`,
      chat: '@store',
      path: `/home/ai/old-${i}.tar`,
      size: 1000,
      mtimeMs: 1757000000000,
      chunkSize: 400,
      done: {},
    }
    await fs.writeFile(file, JSON.stringify(stale))
    const when = new Date(Date.UTC(2020, 0, 1) + i * 60_000)
    await fs.utimes(file, when, when)
  }

  await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    {
      ...deps(fakeClient()),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
      writeErr: (line) => warnings.push(line),
    },
  )

  const left = await fs.readdir(stateDirPath)
  assert.equal(left.length, MAX_STATES - 1, 'the new backup takes the last slot')
  assert.ok(!left.includes('stale0.json'), 'the oldest state is the one dropped')
  assert.match(warnings.join(''), /telstore-stale-0/)
})

test('a file changed during the upload sends no manifest and gives a clear error', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)

  // After the first chunk another process overwrites the file — exactly the case of a
  // VM image or database dump still being written while telstore reads it.
  let alreadyChanged = false
  const changeFileAfterFirstChunk = {
    ...deps(client),
    sendChunk: async (c, peer, args) => {
      const message = await deps(client).sendChunk(c, peer, args)
      if (!alreadyChanged) {
        alreadyChanged = true
        await fs.appendFile(ws.filePath, randomBytes(100))
      }
      return message
    },
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  }

  await assert.rejects(
    () => runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, changeFileAfterFirstChunk),
    (err) => {
      assert.match(err.message, /changed during the upload/)
      assert.match(err.message, /cannot be trusted/)
      assert.match(err.message, /run again/i)
      return true
    },
  )

  assert.equal(
    client.messages.filter((m) => m.fileName.endsWith('.manifest.json')).length,
    0,
    'no manifest may be sent for a hybrid backup',
  )

  // The old run's state is still there; the next run gets a different key because the
  // mtime changed, so it automatically becomes a new backup rather than resuming into
  // stale data.
  assert.ok(await loadState(key, ws.configDir), 'the old state is kept')

  const newStat = await fs.stat(ws.filePath)
  const newKey = stateKey(path.resolve(ws.filePath), newStat.size, newStat.mtimeMs)
  assert.notEqual(newKey, key, 'a changed file changes the key, so next time is a new backup')
})

test('an oversized --upload-concurrency is blocked instead of holding gigabytes of buffers', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@store', 'chunk-size': '400', 'upload-concurrency': '4000' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    (err) => {
      assert.match(err.message, /--upload-concurrency/)
      assert.match(err.message, /1 to 64/)
      return true
    },
  )

  assert.equal(client.messages.length, 0)
})

test('--upload-concurrency of exactly 64 still runs', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400', 'upload-concurrency': '64' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(result.chunks, 3)
})

test('a long FLOOD_WAIT is announced clearly instead of hanging in silence', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  // The first part hits FLOOD_WAIT_3600 once and then goes through.
  let alreadyFlooded = false
  const originalInvoke = client.invoke.bind(client)
  client.invoke = async (request) => {
    if (!alreadyFlooded && request.filePart === 0) {
      alreadyFlooded = true
      const err = new Error('FLOOD_WAIT_3600')
      err.code = 420
      err.seconds = 3600
      err.errorMessage = 'FLOOD_WAIT_3600'
      throw err
    }
    return await originalInvoke(request)
  }

  const lines = []

  await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    {
      ...deps(client),
      configDir: ws.configDir,
      partSize: 128,
      silent: false,
      writeErr: (line) => lines.push(line),
      retryOptions: { sleep: async () => {} },
    },
  )

  const output = lines.join('')
  assert.match(output, /Telegram wants 1h0m/)
  assert.match(output, /FLOOD_WAIT_3600/)
  assert.match(output, /leave it running/)
})

// Telegram throws off a handful of transient errors on any large transfer, and each one
// recovers on the next try. Announcing every one of them buries the progress bar; saying
// nothing at all would hide a link that has genuinely started to struggle.
test('the first retries pass without a word, the third is announced', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  let failures = 0
  const originalInvoke = client.invoke.bind(client)
  client.invoke = async (request) => {
    if (failures < 3 && request.filePart === 0) {
      failures += 1
      throw new Error('flaky network')
    }
    return await originalInvoke(request)
  }

  const lines = []

  await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    {
      ...deps(client),
      configDir: ws.configDir,
      partSize: 128,
      silent: false,
      writeErr: (line) => lines.push(line),
      retryOptions: { sleep: async () => {} },
    },
  )

  const output = lines.join('')
  assert.doesNotMatch(output, /retry 1 /)
  assert.doesNotMatch(output, /retry 2 /)
  assert.match(output, /Temporary error \(flaky network\), retry 3 in 4s/)
  assert.doesNotMatch(output, /Telegram wants/)
})

// The one thing the quiet must not swallow. An attempt that takes a minute to fail leaves
// the bar frozen for that minute, which is indistinguishable from a hang — the very failure
// src/stall.js exists to end. Two of those before the third retry would be two silent
// minutes, so a slow failure is announced the first time whatever its attempt number.
test('an attempt that took a minute to fail is announced on the first retry', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  let alreadyFailed = false
  const originalInvoke = client.invoke.bind(client)
  client.invoke = async (request) => {
    if (!alreadyFailed && request.filePart === 0) {
      alreadyFailed = true
      throw new Error('Telegram stopped acknowledging part 1/4 of x')
    }
    return await originalInvoke(request)
  }

  const lines = []
  // A clock that jumps a minute on every reading, so the attempt reads as a stall.
  let ticks = 0

  await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    {
      ...deps(client),
      configDir: ws.configDir,
      partSize: 128,
      silent: false,
      writeErr: (line) => lines.push(line),
      retryOptions: { sleep: async () => {}, now: () => (ticks += 60_000) },
    },
  )

  assert.match(lines.join(''), /stopped acknowledging.*retry 1 /s)
})

test('silent prints nothing to stderr, even on a FLOOD_WAIT', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  let alreadyFlooded = false
  const originalInvoke = client.invoke.bind(client)
  client.invoke = async (request) => {
    if (!alreadyFlooded && request.filePart === 0) {
      alreadyFlooded = true
      const err = new Error('FLOOD_WAIT_3600')
      err.code = 420
      err.seconds = 3600
      err.errorMessage = 'FLOOD_WAIT_3600'
      throw err
    }
    return await originalInvoke(request)
  }

  const lines = []

  await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400' },
    {
      ...deps(client),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
      writeErr: (line) => lines.push(line),
      retryOptions: { sleep: async () => {} },
    },
  )

  assert.deepEqual(lines, [])
})

test('upload draws one bar for the whole file, not one per chunk', async () => {
  const ws = await tempWorkspace(1000)
  const written = []

  await runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
    ...deps(fakeClient()),
    configDir: ws.configDir,
    partSize: 128,
    silent: false,
    log: () => {},
    writeErr: (line) => written.push(line),
  })

  const text = written.join('')
  assert.match(text, /Chunk 1\/3/)
  assert.match(text, /Chunk 2\/3/)
  assert.match(text, /Chunk 3\/3/)

  assert.equal(
    written.filter((line) => line.endsWith('\n')).length,
    1,
    'the bar owns one line for the whole upload',
  )
  assert.ok(
    written.every((line) => line.includes('/1000 B')),
    'the total is the file, never the chunk in flight',
  )
  assert.doesNotMatch(text, /\/400 B/)

  const percents = written.map((line) => Number(line.match(/(\d+)%/)[1]))

  for (let i = 1; i < percents.length; i += 1) {
    assert.ok(percents[i] >= percents[i - 1], `${percents[i]}% came after ${percents[i - 1]}%`)
  }

  assert.equal(percents.at(0), 0)
  assert.ok(percents.includes(40), 'the bar carries chunk 1 over into chunk 2')
  assert.ok(percents.includes(80), 'the bar carries chunk 2 over into chunk 3')
  assert.equal(percents.at(-1), 100)
})

test('a resumed upload starts the bar where the last run stopped', async () => {
  const ws = await tempWorkspace(1000)

  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(fakeClient({ failOnChunk: 1 })),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const written = []

  await runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
    ...deps(fakeClient()),
    configDir: ws.configDir,
    partSize: 128,
    silent: false,
    log: () => {},
    writeErr: (line) => written.push(line),
  })

  assert.match(written[0], /Chunk 2\/3/)
  assert.match(written[0], /40%/, 'the 400 bytes of the first run are already on the bar')
  assert.match(written.at(-1), /100%/)
  assert.equal(written.filter((line) => line.endsWith('\n')).length, 1)
})

test('chunks already in the chat are reported before the bar starts', async () => {
  const ws = await tempWorkspace(1000)

  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(fakeClient({ failOnChunk: 1 })),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const out = []

  await runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
    ...deps(fakeClient()),
    configDir: ws.configDir,
    partSize: 128,
    silent: false,
    log: (line) => out.push(['log', line]),
    writeErr: (line) => out.push(['err', line]),
  })

  const skipped = out.findIndex(([, line]) => line.includes('already uploaded, skipping.'))
  const firstBar = out.findIndex(([stream, line]) => stream === 'err' && line.includes('%'))

  assert.ok(skipped >= 0, 'the skipped chunk is still reported')
  assert.ok(
    skipped < firstBar,
    'stdout must be done before the bar claims the line it keeps returning to',
  )
})

test('nothing left to send draws no bar at all', async () => {
  const ws = await tempWorkspace(1000)

  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
      ...deps(fakeClient()),
      sendManifest: async () => {
        throw new Error('connection dropped before the manifest')
      },
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
    /before the manifest/,
  )

  const logged = []
  const written = []

  await runUpload(ws.filePath, { to: '@store', 'chunk-size': '400' }, {
    ...deps(fakeClient()),
    configDir: ws.configDir,
    partSize: 128,
    silent: false,
    log: (line) => logged.push(line),
    writeErr: (line) => written.push(line),
  })

  assert.equal(
    logged.filter((line) => line.includes('already uploaded, skipping.')).length,
    3,
    'all three chunks are reported as already sent',
  )
  assert.deepEqual(written, [], 'a bar that never has a byte to move is never drawn')
})

// A state file is JSON on disk that nothing validates on the way in. A truncated write or a
// hand edit can leave a chunkSize the planner cannot use, and the planner's own message
// talks about chunk sizes — sending the reader hunting through a --chunk-size flag they
// never passed. Say where the number actually came from.
test('a state file with an unusable chunk size names the file rather than the flag', async () => {
  const ws = await tempWorkspace(1000)
  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const file = stateFile(key, ws.configDir)

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({
      id: 'telstore-20260101-aaaaaa',
      chat: '@store',
      path: path.resolve(ws.filePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      chunkSize: 0,
      done: {},
    }),
  )

  await assert.rejects(
    () =>
      runUpload(ws.filePath, { to: '@store' }, {
        ...deps(fakeClient()),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    (err) => {
      assert.match(err.message, /record of this unfinished backup/i)
      assert.match(err.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    },
  )
})
