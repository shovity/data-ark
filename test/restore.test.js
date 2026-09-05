import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runRestore, realDownloadChunk } from '../src/commands/restore.js'
import { buildManifest, serializeManifest, manifestFileName } from '../src/manifest.js'
import { saveConfig } from '../src/config.js'
import { createProgress } from '../src/progress.js'

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Builds a fake "chat" holding the chunks and manifest of one backup.
 */
function fakeBackup({ id = 'ark-20260905-7f3a91', name = 'data.tar', chunkSize = 400, total = 1000 } = {}) {
  const content = randomBytes(total)
  const messages = []
  const chunks = []

  for (let offset = 0, i = 0; offset < total; offset += chunkSize, i += 1) {
    const bytes = content.subarray(offset, Math.min(offset + chunkSize, total))
    const msgId = 1000 + i
    messages.push({ id: msgId, fileName: `${id}.part${String(i + 1).padStart(4, '0')}`, bytes })
    chunks.push({ i, msgId, size: bytes.length, sha256: sha(bytes) })
  }

  const manifest = buildManifest({ id, name, size: total, chunkSize, chunks })
  const manifestBytes = serializeManifest(manifest)
  messages.push({ id: 2000, fileName: manifestFileName(id), bytes: manifestBytes })

  return { id, content, messages, manifest, manifestBytes }
}

function fakeClient(backup, { hideMessageId = null, corruptMessageId = null, truncateMessageId = null } = {}) {
  const visible = backup.messages.filter((m) => m.id !== hideMessageId)

  return {
    async searchManifest(peer, query) {
      return visible.find((m) => m.fileName === `${query}.manifest.json`) ?? null
    },
    async readMessageBytes(message) {
      return message.bytes
    },
    async getMessage(peer, msgId) {
      return visible.find((m) => m.id === msgId) ?? null
    },
    iterDownload({ file }) {
      let bytes = file.bytes
      if (file.id === corruptMessageId) bytes = randomBytes(file.bytes.length)
      if (file.id === truncateMessageId) bytes = file.bytes.subarray(0, file.bytes.length - 10)
      return (async function* () {
        yield bytes
      })()
    },
  }
}

function deps(client, configDir) {
  return {
    connect: async () => client,
    disconnect: async () => {},
    configDir,
    silent: true,
    searchManifest: (c, peer, query) => c.searchManifest(peer, query),
    readMessageBytes: (c, message) => c.readMessageBytes(message),
    getMessage: (c, peer, msgId) => c.getMessage(peer, msgId),
    downloadChunk: async (c, message, handle, offset) => {
      const hash = createHash('sha256')
      let written = 0
      for await (const buf of c.iterDownload({ file: { id: message.id, bytes: message.bytes } })) {
        await handle.write(buf, 0, buf.length, offset + written)
        hash.update(buf)
        written += buf.length
      }
      return { sha256: hash.digest('hex'), size: written }
    },
  }
}

async function tempConfig(defaultChat = '@store') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-restore-'))
  const configDir = path.join(dir, 'config')
  await saveConfig({ apiId: 1, apiHash: 'h', session: 's', defaultChat }, configDir)
  return { dir, configDir }
}

test('reassembles the original file exactly', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  const result = await runRestore(backup.id, { out }, deps(fakeClient(backup), configDir))

  assert.equal(result.path, out)
  assert.equal(result.size, 1000)
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('without --out it uses the name from the manifest', async () => {
  const backup = fakeBackup({ name: 'backup.tar' })
  const { dir, configDir } = await tempConfig()
  const cwd = process.cwd()
  process.chdir(dir)

  try {
    const result = await runRestore(backup.id, {}, deps(fakeClient(backup), configDir))
    assert.equal(path.basename(result.path), 'backup.tar')
    assert.deepEqual(await fs.readFile(result.path), backup.content)
  } finally {
    process.chdir(cwd)
  }
})

test('leaves no .partial file behind on success', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  await runRestore(backup.id, { out }, deps(fakeClient(backup), configDir))

  const files = await fs.readdir(dir)
  assert.ok(!files.some((f) => f.endsWith('.partial')), `left behind: ${files.join(', ')}`)
})

test('a missing manifest is reported with the backup id', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const client = fakeClient(backup, { hideMessageId: 2000 })

  await assert.rejects(
    () => runRestore(backup.id, { out: path.join(dir, 'out.tar') }, deps(client, configDir)),
    new RegExp(backup.id),
  )
})

test('a missing chunk stops immediately and names which one', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const client = fakeClient(backup, { hideMessageId: 1001 })

  await assert.rejects(
    () => runRestore(backup.id, { out: path.join(dir, 'out.tar') }, deps(client, configDir)),
    /chunk 2\/3/,
  )
})

test('a sha256 mismatch errors and keeps the .partial file for inspection', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const client = fakeClient(backup, { corruptMessageId: 1001 })

  await assert.rejects(() => runRestore(backup.id, { out }, deps(client, configDir)), /does not match/)

  const files = await fs.readdir(dir)
  assert.ok(files.includes('out.tar.partial'))
  assert.ok(!files.includes('out.tar'))
})

test('an existing target is not overwritten unless confirmed', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  await fs.writeFile(out, 'old data')

  await assert.rejects(
    () => runRestore(backup.id, { out }, { ...deps(fakeClient(backup), configDir), confirm: async () => false }),
    /Cancelled/,
  )

  assert.equal(await fs.readFile(out, 'utf8'), 'old data')

  await runRestore(backup.id, { out }, { ...deps(fakeClient(backup), configDir), confirm: async () => true })
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('a path-traversing name in the manifest still writes into the current directory', async () => {
  const backup = fakeBackup({ name: '../../etc/evil.tar' })
  const { dir, configDir } = await tempConfig()
  const cwd = process.cwd()
  process.chdir(dir)

  try {
    const result = await runRestore(backup.id, {}, deps(fakeClient(backup), configDir))
    assert.equal(path.dirname(result.path), dir)
    assert.equal(path.basename(result.path), 'evil.tar')
    assert.deepEqual(await fs.readFile(result.path), backup.content)
  } finally {
    process.chdir(cwd)
  }
})

test('chunk progress tracks the downloaded data instead of sticking at 0%', async () => {
  const bytes = randomBytes(900)
  const document = { size: bytes.length }
  const message = { id: 1, media: { document } }

  const client = {
    iterDownload({ file }) {
      assert.equal(file, message.media)
      return (async function* () {
        yield bytes.subarray(0, 300)
        yield bytes.subarray(300, 600)
        yield bytes.subarray(600, 900)
      })()
    },
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-progress-'))
  const handle = await fs.open(path.join(dir, 'out.bin'), 'w+')
  await handle.truncate(900)

  const lines = []
  let tick = 0
  const progress = createProgress({
    total: 900,
    label: 'Chunk 1/1',
    write: (line) => lines.push(line),
    now: () => (tick += 300),
    minIntervalMs: 0,
  })

  try {
    const result = await realDownloadChunk(client, message, handle, 0, progress.advance)
    progress.finish()

    assert.equal(result.size, 900)
    assert.equal(result.sha256, sha(bytes))

    const percents = lines.map((line) => Number(line.match(/(\d+)%/)[1]))
    assert.ok(
      percents.some((p) => p > 0 && p < 100),
      `no line shows intermediate progress (>0% and <100%): ${lines.join(' | ')}`,
    )
    assert.equal(percents.at(-1), 100, `the last line must be 100%: ${lines.join(' | ')}`)
  } finally {
    await handle.close()
  }
})

test('a short chunk reports the byte counts, not just a sha256 mismatch', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')
  const client = fakeClient(backup, { truncateMessageId: 1001 })

  await assert.rejects(
    () => runRestore(backup.id, { out }, deps(client, configDir)),
    /Chunk 2 has 390 bytes, the manifest records 400 bytes/,
  )

  const files = await fs.readdir(dir)
  assert.ok(files.includes('out.tar.partial'), 'the .partial is kept for inspection')
  assert.ok(!files.includes('out.tar'), 'it must not be renamed into the real file')
})

test('a manifest name of ".." is rejected with a pointer to --out', async () => {
  const backup = fakeBackup({ name: '..' })
  const { dir, configDir } = await tempConfig()

  // Run inside a subdirectory so the parent ("..") is a directory we own, rather than
  // os.tmpdir(), which the test files running in parallel also write into.
  const workDir = path.join(dir, 'work')
  await fs.mkdir(workDir)
  const before = new Set(await fs.readdir(dir))

  const cwd = process.cwd()
  process.chdir(workDir)

  try {
    await assert.rejects(() => runRestore(backup.id, {}, deps(fakeClient(backup), configDir)), /--out/)

    const created = (await fs.readdir(dir)).filter((f) => !before.has(f))
    assert.deepEqual(created, [], `nothing may be created in the parent, but found: ${created.join(', ')}`)
  } finally {
    process.chdir(cwd)
  }
})

test('a manifest name of "." or empty is rejected too', async () => {
  for (const name of ['.', '', '/']) {
    const backup = fakeBackup({ name })
    const { dir, configDir } = await tempConfig()
    const cwd = process.cwd()
    process.chdir(dir)

    try {
      await assert.rejects(
        () => runRestore(backup.id, {}, deps(fakeClient(backup), configDir)),
        /--out/,
        `the name ${JSON.stringify(name)} must be rejected`,
      )
    } finally {
      process.chdir(cwd)
    }
  }
})

test('an assembled file of the wrong length errors instead of being renamed', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'out.tar')

  // Simulate a layout bug: the last chunk is written 100 bytes too far along, but
  // still reports the right size and sha256, so every per-chunk check passes.
  const base = deps(fakeClient(backup), configDir)
  const skewed = {
    ...base,
    downloadChunk: (c, message, handle, offset, onProgress) =>
      base.downloadChunk(c, message, handle, message.id === 1002 ? offset + 100 : offset, onProgress),
  }

  await assert.rejects(
    () => runRestore(backup.id, { out }, skewed),
    /The assembled file has 1100 bytes, the manifest records 1000 bytes/,
  )

  const files = await fs.readdir(dir)
  assert.ok(files.includes('out.tar.partial'))
  assert.ok(!files.includes('out.tar'))
})
