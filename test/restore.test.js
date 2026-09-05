import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runRestore } from '../src/commands/restore.js'
import { buildManifest, serializeManifest, manifestFileName } from '../src/manifest.js'
import { saveConfig } from '../src/config.js'

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Dựng một "chat" giả chứa các chunk và manifest của một backup.
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

function fakeClient(backup, { hideMessageId = null, corruptMessageId = null } = {}) {
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
      const bytes = file.id === corruptMessageId ? randomBytes(file.bytes.length) : file.bytes
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

async function tempConfig(defaultChat = '@kho') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-restore-'))
  const configDir = path.join(dir, 'config')
  await saveConfig({ apiId: 1, apiHash: 'h', session: 's', defaultChat }, configDir)
  return { dir, configDir }
}

test('ghép lại đúng file gốc', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'ra.tar')

  const result = await runRestore(backup.id, { out }, deps(fakeClient(backup), configDir))

  assert.equal(result.path, out)
  assert.equal(result.size, 1000)
  assert.deepEqual(await fs.readFile(out), backup.content)
})

test('không có --out thì dùng tên trong manifest', async () => {
  const backup = fakeBackup({ name: 'sao-luu.tar' })
  const { dir, configDir } = await tempConfig()
  const cwd = process.cwd()
  process.chdir(dir)

  try {
    const result = await runRestore(backup.id, {}, deps(fakeClient(backup), configDir))
    assert.equal(path.basename(result.path), 'sao-luu.tar')
    assert.deepEqual(await fs.readFile(result.path), backup.content)
  } finally {
    process.chdir(cwd)
  }
})

test('không để lại file .partial khi thành công', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'ra.tar')

  await runRestore(backup.id, { out }, deps(fakeClient(backup), configDir))

  const files = await fs.readdir(dir)
  assert.ok(!files.some((f) => f.endsWith('.partial')), `còn sót: ${files.join(', ')}`)
})

test('không tìm thấy manifest thì báo lỗi kèm backup id', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const client = fakeClient(backup, { hideMessageId: 2000 })

  await assert.rejects(
    () => runRestore(backup.id, { out: path.join(dir, 'ra.tar') }, deps(client, configDir)),
    new RegExp(backup.id),
  )
})

test('thiếu một chunk thì dừng ngay và nói rõ chunk nào', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const client = fakeClient(backup, { hideMessageId: 1001 })

  await assert.rejects(
    () => runRestore(backup.id, { out: path.join(dir, 'ra.tar') }, deps(client, configDir)),
    /chunk 2\/3/,
  )
})

test('sha256 lệch thì báo lỗi và giữ lại file .partial để điều tra', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'ra.tar')
  const client = fakeClient(backup, { corruptMessageId: 1001 })

  await assert.rejects(() => runRestore(backup.id, { out }, deps(client, configDir)), /không khớp/)

  const files = await fs.readdir(dir)
  assert.ok(files.includes('ra.tar.partial'))
  assert.ok(!files.includes('ra.tar'))
})

test('file đích đã tồn tại thì từ chối ghi đè trừ khi được đồng ý', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'ra.tar')
  await fs.writeFile(out, 'dữ liệu cũ')

  await assert.rejects(
    () => runRestore(backup.id, { out }, { ...deps(fakeClient(backup), configDir), confirm: async () => false }),
    /Đã huỷ/,
  )

  assert.equal(await fs.readFile(out, 'utf8'), 'dữ liệu cũ')

  await runRestore(backup.id, { out }, { ...deps(fakeClient(backup), configDir), confirm: async () => true })
  assert.deepEqual(await fs.readFile(out), backup.content)
})
