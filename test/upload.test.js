import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runUpload } from '../src/commands/upload.js'
import { parseManifest } from '../src/manifest.js'
import { loadState, stateKey } from '../src/state.js'

/**
 * Fake client that collects every part by fileId and, when sendFile is called,
 * "seals" the uploaded content into a message with an increasing id.
 */
function fakeClient({ failOnChunk = null } = {}) {
  const parts = new Map()
  const messages = []
  let nextId = 1000

  return {
    messages,
    async invoke(request) {
      const key = request.fileId.toString()
      if (!parts.has(key)) parts.set(key, [])
      parts.get(key).push({ index: request.filePart, bytes: Buffer.from(request.bytes) })
      return true
    },
    async sendFile(peer, { file, caption, attributes }) {
      const fileName = attributes?.[0]?.fileName ?? file.name
      const chunkIndex = messages.filter((m) => !m.fileName.endsWith('.manifest.json')).length

      if (failOnChunk !== null && chunkIndex === failOnChunk) {
        throw new Error('connection dropped mid-transfer')
      }

      const collected = parts.get(file.id?.toString()) ?? []
      const bytes = Buffer.concat(
        [...collected].sort((a, b) => a.index - b.index).map((p) => p.bytes),
      )

      nextId += 1
      const message = { id: nextId, peer, fileName, caption, bytes }
      messages.push(message)
      return message
    },
    async sendManifest(peer, { bytes, fileName, caption }) {
      nextId += 1
      const message = { id: nextId, peer, fileName, caption, bytes }
      messages.push(message)
      return message
    },
  }
}

async function tempWorkspace(fileSize) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-upload-cmd-'))
  const filePath = path.join(dir, 'data.tar')
  const content = randomBytes(fileSize)
  await fs.writeFile(filePath, content)
  return { dir, filePath, content, configDir: path.join(dir, 'config') }
}

function deps(client) {
  return {
    connect: async () => client,
    sendChunk: async (c, peer, { inputFile, fileName, caption }) =>
      c.sendFile(peer, { file: inputFile, caption, attributes: [{ fileName }] }),
    sendManifest: async (c, peer, args) => c.sendManifest(peer, args),
    disconnect: async () => {},
  }
}

test('splits the file into the right number of chunks and uploads them all', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400', concurrency: '2' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(result.chunks, 3)
  assert.match(result.id, /^ark-\d{8}-[0-9a-f]{6}$/)

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
  assert.match(first.caption, new RegExp(`#dataark ${result.id} 1/3`))
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

test('--to is remembered as the default destination', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  await runUpload(
    ws.filePath,
    { to: '@new_store', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  const config = JSON.parse(await fs.readFile(path.join(ws.configDir, 'config.json'), 'utf8'))
  assert.equal(config.defaultChat, '@new_store')
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

test('a non-numeric --concurrency gives a clear error', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@store', 'chunk-size': '400', concurrency: 'abc' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    /--concurrency/,
  )
})

test('--concurrency of 0 gives a clear error instead of hanging forever', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@store', 'chunk-size': '400', concurrency: '0' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    /--concurrency/,
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
      assert.match(err.message, /--to/)
      assert.match(err.message, /\.json/)
      return true
    },
  )

  assert.equal(retry.messages.length, 0, 'nothing may be sent once the run is blocked')

  const config = JSON.parse(await fs.readFile(path.join(ws.configDir, 'config.json'), 'utf8'))
  assert.equal(config.defaultChat, '@store', 'the default destination must not be overwritten when blocked')
})

test('resuming with a different --chunk-size starts a new backup and drops the old done set', async () => {
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
  const result = await runUpload(ws.filePath, { to: '@store', 'chunk-size': '250' }, {
    ...deps(retry),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  assert.notEqual(result.id, firstRunId, 'it must be a new backup id')
  assert.equal(result.chunks, 4)

  const chunkMessages = retry.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.equal(chunkMessages.length, 4, 'everything is re-uploaded, no old done chunks are kept')
})

test('a file changed during the upload sends no manifest and gives a clear error', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)

  // After the first chunk another process overwrites the file — exactly the case of a
  // VM image or database dump still being written while data-ark reads it.
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

test('an oversized --concurrency is blocked instead of holding gigabytes of buffers', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@store', 'chunk-size': '400', concurrency: '4000' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    (err) => {
      assert.match(err.message, /--concurrency/)
      assert.match(err.message, /1 to 64/)
      return true
    },
  )

  assert.equal(client.messages.length, 0)
})

test('--concurrency of exactly 64 still runs', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@store', 'chunk-size': '400', concurrency: '64' },
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

test('a short temporary error is announced too, with the attempt number', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  let alreadyFailed = false
  const originalInvoke = client.invoke.bind(client)
  client.invoke = async (request) => {
    if (!alreadyFailed && request.filePart === 0) {
      alreadyFailed = true
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
  assert.match(output, /Temporary error \(flaky network\), retry 1 in 1s/)
  assert.doesNotMatch(output, /Telegram wants/)
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
