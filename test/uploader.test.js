import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Api } from 'telegram'

import { uploadRange } from '../src/uploader.js'

/**
 * Client giả: ghi lại mọi request SaveBigFilePart để test có thể ghép
 * các part lại và so với dải byte gốc.
 */
function fakeClient({ failFirstPart = false } = {}) {
  const requests = []
  let failed = false

  return {
    requests,
    async invoke(request) {
      if (failFirstPart && !failed && request.filePart === 0) {
        failed = true
        throw new Error('mạng lỗi')
      }
      requests.push({
        fileId: request.fileId.toString(),
        filePart: request.filePart,
        fileTotalParts: request.fileTotalParts,
        bytes: Buffer.from(request.bytes),
      })
      return true
    },
  }
}

function reassemble(requests) {
  return Buffer.concat(
    [...requests].sort((a, b) => a.filePart - b.filePart).map((r) => r.bytes),
  )
}

async function tempFile(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-upload-'))
  const file = path.join(dir, 'nguon.bin')
  await fs.writeFile(file, content)
  const handle = await fs.open(file, 'r')
  return { file, handle }
}

test('upload cả file nhỏ hơn một part', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'ark-1.part0001',
    partSize: 512,
  })

  assert.equal(result.parts, 2)
  assert.equal(client.requests.length, 2)
  assert.deepEqual(reassemble(client.requests), content)
  await handle.close()
})

test('sha256 trả về đúng của dải byte đã upload', async () => {
  const content = randomBytes(3000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
  })

  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  await handle.close()
})

test('chỉ upload đúng dải byte được yêu cầu, không phải cả file', async () => {
  const content = randomBytes(5000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 1000,
    length: 2000,
    fileName: 'x',
    partSize: 512,
  })

  const expected = content.subarray(1000, 3000)
  assert.deepEqual(reassemble(client.requests), expected)
  assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'))
  await handle.close()
})

test('mọi part dùng chung một fileId và cùng fileTotalParts', async () => {
  const content = randomBytes(3000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
  })

  const fileIds = new Set(client.requests.map((r) => r.fileId))
  assert.equal(fileIds.size, 1)
  assert.ok(client.requests.every((r) => r.fileTotalParts === result.parts))
  assert.deepEqual(
    client.requests.map((r) => r.filePart).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5],
  )
  await handle.close()
})

test('part cuối ngắn hơn part size', async () => {
  const content = randomBytes(1025)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  await uploadRange(client, handle.fd, { offset: 0, length: content.length, fileName: 'x', partSize: 512 })

  const last = client.requests.find((r) => r.filePart === 2)
  assert.equal(last.bytes.length, 1)
  await handle.close()
})

test('trả về InputFileBig dùng được cho sendFile', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'ark-1.part0001',
    partSize: 512,
  })

  assert.ok(result.inputFile instanceof Api.InputFileBig)
  assert.equal(result.inputFile.name, 'ark-1.part0001')
  assert.equal(result.inputFile.parts, 2)
  await handle.close()
})

test('part hỏng được thử lại và dữ liệu vẫn nguyên vẹn', async () => {
  const content = randomBytes(2000)
  const { handle } = await tempFile(content)
  const client = fakeClient({ failFirstPart: true })

  await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
    retryOptions: { baseDelayMs: 1, sleep: async () => {} },
  })

  assert.deepEqual(reassemble(client.requests), content)
  await handle.close()
})

test('từ chối dải byte cần quá 4000 part', async () => {
  const content = randomBytes(10)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  await assert.rejects(
    () => uploadRange(client, handle.fd, { offset: 0, length: 4001, fileName: 'x', partSize: 1 }),
    /4000 phần/,
  )
  await handle.close()
})

test('onProgress báo số byte đã gửi, cộng dồn tới đúng tổng', async () => {
  const content = randomBytes(2000)
  const { handle } = await tempFile(content)
  const client = fakeClient()
  const seen = []

  await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
    onProgress: (bytes) => seen.push(bytes),
  })

  assert.equal(seen.reduce((a, b) => a + b, 0), 2000)
  await handle.close()
})
