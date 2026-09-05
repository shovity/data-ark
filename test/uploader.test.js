import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Api } from 'telegram'

import { uploadRange, LARGE_FILE_THRESHOLD } from '../src/uploader.js'

/**
 * Client giả: ghi lại mọi request upload để test có thể ghép các part lại,
 * so với dải byte gốc, và kiểm xem API nào đã được dùng.
 */
function fakeClient({ failFirstPart = false, failEveryPart = false } = {}) {
  const requests = []
  let failed = false

  return {
    requests,
    async invoke(request) {
      if (failEveryPart) {
        throw new Error('mạng lỗi')
      }
      if (failFirstPart && !failed && request.filePart === 0) {
        failed = true
        throw new Error('mạng lỗi')
      }
      requests.push({
        className: request.className,
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

test('mọi part dùng chung một fileId và đủ số thứ tự', async () => {
  const content = randomBytes(3000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
  })

  const fileIds = new Set(client.requests.map((r) => r.fileId))
  assert.equal(fileIds.size, 1)
  assert.deepEqual(
    client.requests.map((r) => r.filePart).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5],
  )
  await handle.close()
})

test('nhiều lô (concurrency thấp hơn số part): không part nào bị bỏ sót hay gửi trùng', async () => {
  const content = randomBytes(3000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'x',
    partSize: 512,
    concurrency: 2,
  })

  assert.equal(result.parts, 6)

  const filePartValues = client.requests.map((r) => r.filePart)
  assert.deepEqual([...filePartValues].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5])
  assert.equal(new Set(filePartValues).size, filePartValues.length)

  assert.deepEqual(reassemble(client.requests), content)
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
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

test('dải byte <= 10MB dùng SaveFilePart và trả về InputFile', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'ark-1.part0001',
    partSize: 512,
  })

  assert.ok(
    client.requests.every((r) => r.className === 'upload.SaveFilePart'),
    `phải dùng SaveFilePart: ${client.requests.map((r) => r.className).join(', ')}`,
  )
  assert.ok(
    client.requests.every((r) => r.fileTotalParts === undefined),
    'SaveFilePart không có trường fileTotalParts',
  )

  assert.ok(result.inputFile instanceof Api.InputFile)
  assert.ok(!(result.inputFile instanceof Api.InputFileBig))
  assert.equal(result.inputFile.name, 'ark-1.part0001')
  assert.equal(result.inputFile.parts, 2)
  assert.equal(result.inputFile.md5Checksum, '')
  await handle.close()
})

test('đúng 10MB vẫn là phía nhỏ của ngưỡng', async () => {
  const content = randomBytes(LARGE_FILE_THRESHOLD)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'ark-1.part0001',
  })

  assert.ok(result.inputFile instanceof Api.InputFile)
  assert.ok(client.requests.every((r) => r.className === 'upload.SaveFilePart'))
  await handle.close()
})

test('dải byte > 10MB dùng SaveBigFilePart và trả về InputFileBig', async () => {
  const content = randomBytes(LARGE_FILE_THRESHOLD + 1)
  const { handle } = await tempFile(content)
  const client = fakeClient()

  const result = await uploadRange(client, handle.fd, {
    offset: 0,
    length: content.length,
    fileName: 'ark-1.part0001',
  })

  assert.ok(
    client.requests.every((r) => r.className === 'upload.SaveBigFilePart'),
    `phải dùng SaveBigFilePart: ${client.requests.map((r) => r.className).join(', ')}`,
  )
  assert.ok(
    client.requests.every((r) => r.fileTotalParts === result.parts),
    'SaveBigFilePart phải mang fileTotalParts',
  )

  assert.ok(result.inputFile instanceof Api.InputFileBig)
  assert.equal(result.inputFile.name, 'ark-1.part0001')
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
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

test('lỗi đọc file giữa lô không sinh unhandledRejection che mất lỗi thật', async () => {
  const content = randomBytes(2000)
  const { handle } = await tempFile(content)
  // Mọi request đều hỏng, nên các promise đã push chắc chắn sẽ reject sau khi
  // vòng đọc gãy vì đọc quá cuối file.
  const client = fakeClient({ failEveryPart: true })

  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)

  try {
    await assert.rejects(
      () =>
        uploadRange(client, handle.fd, {
          offset: 0,
          // Đòi nhiều byte hơn file có: readExactly sẽ ném ở part cuối.
          length: 3000,
          fileName: 'x',
          partSize: 512,
          concurrency: 8,
          retryOptions: { attempts: 1 },
        }),
      /Đọc hụt/,
    )

    // Cho event loop một nhịp để unhandledRejection kịp bắn nếu có.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(unhandled, [], 'không được để promise nào rơi ra ngoài')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await handle.close()
  }
})
