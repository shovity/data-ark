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
 * Client giả gom mọi part theo fileId, và khi sendFile được gọi thì
 * "chốt" nội dung đã upload lại thành một message có id tăng dần.
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
        throw new Error('mạng đứt giữa chừng')
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

test('cắt file thành đúng số chunk và upload hết', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@kho', 'chunk-size': '400', concurrency: '2' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(result.chunks, 3)
  assert.match(result.id, /^ark-\d{8}-[0-9a-f]{6}$/)

  const chunkMessages = client.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.equal(chunkMessages.length, 3)
  assert.deepEqual(Buffer.concat(chunkMessages.map((m) => m.bytes)), ws.content)
})

test('chunk được đặt tên và gắn caption theo backup id', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@kho', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  const first = client.messages[0]
  assert.equal(first.fileName, `${result.id}.part0001`)
  assert.match(first.caption, new RegExp(`#dataark ${result.id} 1/3`))
})

test('manifest được gửi cuối cùng và mô tả đúng các chunk', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@kho', 'chunk-size': '400' },
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

test('--to được ghi nhớ làm đích mặc định', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  await runUpload(
    ws.filePath,
    { to: '@kho_moi', 'chunk-size': '400' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  const config = JSON.parse(await fs.readFile(path.join(ws.configDir, 'config.json'), 'utf8'))
  assert.equal(config.defaultChat, '@kho_moi')
})

test('không có --to và chưa từng có đích thì báo lỗi hướng dẫn', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(ws.filePath, {}, { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true }),
    /--to/,
  )
})

test('file không tồn tại thì báo lỗi rõ ràng', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(path.join(ws.dir, 'khong-co.tar'), { to: '@kho' }, {
        ...deps(client),
        configDir: ws.configDir,
        silent: true,
      }),
    /không tồn tại/,
  )
})

test('state còn lại sau khi đứt giữa chừng', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient({ failOnChunk: 1 })

  await assert.rejects(
    () =>
      runUpload(ws.filePath, { to: '@kho', 'chunk-size': '400' }, {
        ...deps(client),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    /mạng đứt/,
  )

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const state = await loadState(key, ws.configDir)

  assert.ok(state, 'state phải còn để lần sau resume')
  assert.deepEqual(Object.keys(state.done), ['0'])
})

test('chạy lại sau khi đứt thì bỏ qua chunk đã xong và giữ nguyên backup id', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@kho', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )
  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const idLanDau = (await loadState(key, ws.configDir)).id

  const retry = fakeClient()
  const result = await runUpload(ws.filePath, { to: '@kho', 'chunk-size': '400' }, {
    ...deps(retry),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  assert.equal(result.id, idLanDau)

  const chunkMessages = retry.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.equal(chunkMessages.length, 2, 'chỉ upload lại 2 chunk còn thiếu')

  const manifest = parseManifest(retry.messages.at(-1).bytes)
  assert.equal(manifest.chunks.length, 3, 'manifest vẫn mô tả đủ 3 chunk')
})

test('upload xong thì xoá state', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await runUpload(ws.filePath, { to: '@kho', 'chunk-size': '400' }, {
    ...deps(client),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  assert.equal(await loadState(key, ws.configDir), null)
})

test('--concurrency không phải số thì báo lỗi rõ ràng', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@kho', 'chunk-size': '400', concurrency: 'abc' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    /--concurrency/,
  )
})

test('--concurrency bằng 0 thì báo lỗi rõ ràng thay vì treo vô hạn', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@kho', 'chunk-size': '400', concurrency: '0' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    /--concurrency/,
  )
})

test('resume với --to khác đích cũ thì bị chặn, không tách backup ra hai đích', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@kho', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const retry = fakeClient()
  await assert.rejects(
    () =>
      runUpload(ws.filePath, { to: '@kho_khac', 'chunk-size': '400' }, {
        ...deps(retry),
        configDir: ws.configDir,
        partSize: 128,
        silent: true,
      }),
    (err) => {
      assert.match(err.message, /@kho_khac/)
      assert.match(err.message, /--to/)
      assert.match(err.message, /\.json/)
      return true
    },
  )

  assert.equal(retry.messages.length, 0, 'không được gửi bất cứ gì khi bị chặn')

  const config = JSON.parse(await fs.readFile(path.join(ws.configDir, 'config.json'), 'utf8'))
  assert.equal(config.defaultChat, '@kho', 'không được ghi đè đích mặc định khi bị chặn')
})

test('resume với --chunk-size khác thì bắt đầu backup mới, không giữ done cũ', async () => {
  const ws = await tempWorkspace(1000)

  const failing = fakeClient({ failOnChunk: 1 })
  await assert.rejects(() =>
    runUpload(ws.filePath, { to: '@kho', 'chunk-size': '400' }, {
      ...deps(failing),
      configDir: ws.configDir,
      partSize: 128,
      silent: true,
    }),
  )

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)
  const idLanDau = (await loadState(key, ws.configDir)).id

  const retry = fakeClient()
  const result = await runUpload(ws.filePath, { to: '@kho', 'chunk-size': '250' }, {
    ...deps(retry),
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  })

  assert.notEqual(result.id, idLanDau, 'phải là backup id mới')
  assert.equal(result.chunks, 4)

  const chunkMessages = retry.messages.filter((m) => !m.fileName.endsWith('.manifest.json'))
  assert.equal(chunkMessages.length, 4, 'phải upload lại từ đầu, không giữ chunk done cũ')
})

test('file bị đổi trong lúc upload thì không gửi manifest, báo lỗi rõ ràng', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const stat = await fs.stat(ws.filePath)
  const key = stateKey(path.resolve(ws.filePath), stat.size, stat.mtimeMs)

  // Sau chunk đầu tiên, một tiến trình khác ghi đè file — đúng cảnh một VM image
  // hay dump database vẫn đang được viết trong lúc data-ark đọc nó.
  let daDoi = false
  const doiFileSauChunkDau = {
    ...deps(client),
    sendChunk: async (c, peer, args) => {
      const message = await deps(client).sendChunk(c, peer, args)
      if (!daDoi) {
        daDoi = true
        await fs.appendFile(ws.filePath, randomBytes(100))
      }
      return message
    },
    configDir: ws.configDir,
    partSize: 128,
    silent: true,
  }

  await assert.rejects(
    () => runUpload(ws.filePath, { to: '@kho', 'chunk-size': '400' }, doiFileSauChunkDau),
    (err) => {
      assert.match(err.message, /đã thay đổi trong lúc upload/)
      assert.match(err.message, /không đáng tin/)
      assert.match(err.message, /chạy lại/i)
      return true
    },
  )

  assert.equal(
    client.messages.filter((m) => m.fileName.endsWith('.manifest.json')).length,
    0,
    'không được gửi manifest cho một backup lai',
  )

  // State của lần chạy cũ vẫn còn; lần chạy sau có key khác vì mtime đã đổi, nên
  // tự động là một backup mới chứ không resume nhầm vào dữ liệu cũ.
  assert.ok(await loadState(key, ws.configDir), 'state cũ vẫn được giữ')

  const statMoi = await fs.stat(ws.filePath)
  const keyMoi = stateKey(path.resolve(ws.filePath), statMoi.size, statMoi.mtimeMs)
  assert.notEqual(keyMoi, key, 'file đổi thì key đổi, lần sau là backup mới')
})

test('--concurrency quá lớn bị chặn thay vì ôm hàng GB buffer', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  await assert.rejects(
    () =>
      runUpload(
        ws.filePath,
        { to: '@kho', 'chunk-size': '400', concurrency: '4000' },
        { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
      ),
    (err) => {
      assert.match(err.message, /--concurrency/)
      assert.match(err.message, /1 đến 64/)
      return true
    },
  )

  assert.equal(client.messages.length, 0)
})

test('--concurrency đúng 64 vẫn chạy được', async () => {
  const ws = await tempWorkspace(1000)
  const client = fakeClient()

  const result = await runUpload(
    ws.filePath,
    { to: '@kho', 'chunk-size': '400', concurrency: '64' },
    { ...deps(client), configDir: ws.configDir, partSize: 128, silent: true },
  )

  assert.equal(result.chunks, 3)
})

test('FLOOD_WAIT dài được nói ra rõ ràng chứ không treo câm', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  // Part đầu tiên dính FLOOD_WAIT_3600 một lần rồi mới trót lọt.
  let daFlood = false
  const invokeGoc = client.invoke.bind(client)
  client.invoke = async (request) => {
    if (!daFlood && request.filePart === 0) {
      daFlood = true
      const err = new Error('FLOOD_WAIT_3600')
      err.seconds = 3600
      err.errorMessage = 'FLOOD_WAIT_3600'
      throw err
    }
    return await invokeGoc(request)
  }

  const lines = []

  await runUpload(
    ws.filePath,
    { to: '@kho', 'chunk-size': '400' },
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
  assert.match(output, /Telegram bắt chờ 1h0m/)
  assert.match(output, /FLOOD_WAIT_3600/)
  assert.match(output, /đừng tắt/)
})

test('lỗi tạm thời ngắn cũng được báo, kèm số lần thử', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  let daLoi = false
  const invokeGoc = client.invoke.bind(client)
  client.invoke = async (request) => {
    if (!daLoi && request.filePart === 0) {
      daLoi = true
      throw new Error('mạng chập chờn')
    }
    return await invokeGoc(request)
  }

  const lines = []

  await runUpload(
    ws.filePath,
    { to: '@kho', 'chunk-size': '400' },
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
  assert.match(output, /Lỗi tạm thời \(mạng chập chờn\), thử lại lần 1 sau 1s/)
  assert.doesNotMatch(output, /Telegram bắt chờ/)
})

test('silent thì không in gì ra stderr, kể cả khi có FLOOD_WAIT', async () => {
  const ws = await tempWorkspace(400)
  const client = fakeClient()

  let daFlood = false
  const invokeGoc = client.invoke.bind(client)
  client.invoke = async (request) => {
    if (!daFlood && request.filePart === 0) {
      daFlood = true
      const err = new Error('FLOOD_WAIT_3600')
      err.seconds = 3600
      err.errorMessage = 'FLOOD_WAIT_3600'
      throw err
    }
    return await invokeGoc(request)
  }

  const lines = []

  await runUpload(
    ws.filePath,
    { to: '@kho', 'chunk-size': '400' },
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
