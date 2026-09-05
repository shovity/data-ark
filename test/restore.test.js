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

test('tên file trong manifest có path traversal thì vẫn ghi trong thư mục hiện tại', async () => {
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

test('tiến trình chunk cập nhật theo dữ liệu đã tải, không kẹt ở 0%', async () => {
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
      `không có dòng nào cho thấy tiến trình giữa chừng (>0% và <100%): ${lines.join(' | ')}`,
    )
    assert.equal(percents.at(-1), 100, `dòng cuối phải là 100%: ${lines.join(' | ')}`)
  } finally {
    await handle.close()
  }
})

test('chunk về thiếu byte thì báo đúng số byte lệch, không chỉ nói sha256', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'ra.tar')
  const client = fakeClient(backup, { truncateMessageId: 1001 })

  await assert.rejects(
    () => runRestore(backup.id, { out }, deps(client, configDir)),
    /Chunk 2 có 390 byte, manifest ghi 400 byte/,
  )

  const files = await fs.readdir(dir)
  assert.ok(files.includes('ra.tar.partial'), 'giữ .partial để điều tra')
  assert.ok(!files.includes('ra.tar'), 'không được đổi tên thành file thật')
})

test('tên trong manifest là ".." thì từ chối và bảo dùng --out', async () => {
  const backup = fakeBackup({ name: '..' })
  const { dir, configDir } = await tempConfig()

  // Chạy trong một thư mục con để thư mục cha ("..") là thư mục ta tự dựng,
  // không phải os.tmpdir() vốn bị các file test chạy song song ghi vào.
  const lamViec = path.join(dir, 'lam-viec')
  await fs.mkdir(lamViec)
  const truoc = new Set(await fs.readdir(dir))

  const cwd = process.cwd()
  process.chdir(lamViec)

  try {
    await assert.rejects(() => runRestore(backup.id, {}, deps(fakeClient(backup), configDir)), /--out/)

    const moi = (await fs.readdir(dir)).filter((f) => !truoc.has(f))
    assert.deepEqual(moi, [], `không được tạo gì ở thư mục cha, nhưng thấy: ${moi.join(', ')}`)
  } finally {
    process.chdir(cwd)
  }
})

test('tên trong manifest là "." hoặc rỗng cũng bị từ chối', async () => {
  for (const name of ['.', '', '/']) {
    const backup = fakeBackup({ name })
    const { dir, configDir } = await tempConfig()
    const cwd = process.cwd()
    process.chdir(dir)

    try {
      await assert.rejects(
        () => runRestore(backup.id, {}, deps(fakeClient(backup), configDir)),
        /--out/,
        `tên ${JSON.stringify(name)} phải bị từ chối`,
      )
    } finally {
      process.chdir(cwd)
    }
  }
})

test('file ghép xong sai độ dài thì báo lỗi thay vì đổi tên', async () => {
  const backup = fakeBackup()
  const { dir, configDir } = await tempConfig()
  const out = path.join(dir, 'ra.tar')

  // Giả lập một lỗi bố cục: chunk cuối bị ghi lệch 100 byte về sau, nhưng vẫn
  // báo về đúng size và sha256 nên mọi kiểm tra theo chunk đều xanh.
  const base = deps(fakeClient(backup), configDir)
  const lech = {
    ...base,
    downloadChunk: (c, message, handle, offset, onProgress) =>
      base.downloadChunk(c, message, handle, message.id === 1002 ? offset + 100 : offset, onProgress),
  }

  await assert.rejects(
    () => runRestore(backup.id, { out }, lech),
    /File ghép xong có 1100 byte, manifest ghi 1000 byte/,
  )

  const files = await fs.readdir(dir)
  assert.ok(files.includes('ra.tar.partial'))
  assert.ok(!files.includes('ra.tar'))
})
