import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { downloadToFile } from '../src/downloader.js'

function fakeMessage(document = { id: 'doc-1' }) {
  return { id: 999, media: { document } }
}

function fakeClient(chunks) {
  return {
    calls: [],
    iterDownload(params) {
      this.calls.push(params)
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

async function tempFd(size) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-download-'))
  const file = path.join(dir, 'dich.bin')
  const handle = await fs.open(file, 'w+')
  if (size) await handle.truncate(size)
  return { file, handle }
}

test('ghi nội dung vào đúng đầu file', async () => {
  const content = randomBytes(1500)
  const { file, handle } = await tempFd(1500)
  const client = fakeClient([content.subarray(0, 1000), content.subarray(1000)])

  const result = await downloadToFile(client, fakeMessage(), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(result.size, 1500)
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  assert.deepEqual(await fs.readFile(file), content)
})

test('ghi vào đúng offset giữa file', async () => {
  const dau = Buffer.alloc(1000, 0)
  const noiDung = randomBytes(500)
  const { file, handle } = await tempFd(1500)
  const client = fakeClient([noiDung])

  await downloadToFile(client, fakeMessage(), handle.fd, { offset: 1000 })

  await handle.close()
  const onDisk = await fs.readFile(file)
  assert.deepEqual(onDisk.subarray(0, 1000), dau)
  assert.deepEqual(onDisk.subarray(1000), noiDung)
})

test('truyền document của message cho iterDownload', async () => {
  const { handle } = await tempFd(10)
  const document = { id: 'doc-abc' }
  const client = fakeClient([Buffer.alloc(10)])

  await downloadToFile(client, fakeMessage(document), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(client.calls[0].file, document)
})

test('onProgress cộng dồn đúng tổng số byte', async () => {
  const { handle } = await tempFd(300)
  const client = fakeClient([Buffer.alloc(100), Buffer.alloc(100), Buffer.alloc(100)])
  const seen = []

  await downloadToFile(client, fakeMessage(), handle.fd, { offset: 0, onProgress: (n) => seen.push(n) })

  await handle.close()
  assert.deepEqual(seen, [100, 100, 100])
})

test('báo lỗi rõ ràng khi message không có document', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient([])

  await assert.rejects(
    () => downloadToFile(client, { id: 42, media: null }, handle.fd, { offset: 0 }),
    /không chứa file/,
  )
  await handle.close()
})

test('báo lỗi rõ ràng khi offset không được cung cấp', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient([Buffer.alloc(10)])

  await assert.rejects(
    () => downloadToFile(client, fakeMessage(), handle.fd, {}),
    /offset phải là một số hữu hạn/,
  )
  await handle.close()
})

test('báo lỗi rõ ràng khi offset không phải là số', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient([Buffer.alloc(10)])

  await assert.rejects(
    () => downloadToFile(client, fakeMessage(), handle.fd, { offset: 'abc' }),
    /offset phải là một số hữu hạn/,
  )
  await handle.close()
})
