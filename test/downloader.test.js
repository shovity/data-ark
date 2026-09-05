import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import bigInt from 'big-integer'
import { Api } from 'telegram'
import { getFileInfo } from 'telegram/Utils.js'
import { iterDownload } from 'telegram/client/downloads.js'

import { downloadToFile } from '../src/downloader.js'
import { SLICE_SIZE } from '../src/chunking.js'

// The document is the chunk: its byte 0 is the chunk's byte 0. Callers must say how long it
// is, because downloadToFile plans its slices from that length.
function fakeMessage(size, document = { id: 'doc-1' }) {
  return { id: 999, media: { document: { ...document, size } } }
}

// The real iterDownload streams from `offset` to the end of the document. A fake that
// ignored the offset would let every slice-offset mistake through.
function fakeClient(content, { partSize = 100 } = {}) {
  return {
    calls: [],
    iterDownload(params) {
      this.calls.push(params)
      const from = Number(params.offset ?? 0)

      return (async function* () {
        for (let at = from; at < content.length; at += partSize) {
          yield content.subarray(at, at + partSize)
        }
      })()
    },
  }
}

async function tempFd(size) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-download-'))
  const file = path.join(dir, 'target.bin')
  const handle = await fs.open(file, 'w+')
  if (size) await handle.truncate(size)
  return { file, handle }
}

test('writes the content at the start of the file', async () => {
  const content = randomBytes(1500)
  const { file, handle } = await tempFd(1500)
  const client = fakeClient(content, { partSize: 1000 })

  const result = await downloadToFile(client, fakeMessage(1500), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(result.size, 1500)
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  assert.deepEqual(await fs.readFile(file), content)
})

test('writes at the right offset in the middle of the file', async () => {
  const head = Buffer.alloc(1000, 0)
  const content = randomBytes(500)
  const { file, handle } = await tempFd(1500)
  const client = fakeClient(content)

  await downloadToFile(client, fakeMessage(500), handle.fd, { offset: 1000 })

  await handle.close()
  const onDisk = await fs.readFile(file)
  assert.deepEqual(onDisk.subarray(0, 1000), head)
  assert.deepEqual(onDisk.subarray(1000), content)
})

test("passes the message's media to iterDownload", async () => {
  const { handle } = await tempFd(10)
  const message = fakeMessage(10, { id: 'doc-abc' })
  const client = fakeClient(Buffer.alloc(10))

  await downloadToFile(client, message, handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(client.calls[0].file, message.media)
})

test('whatever is passed to iterDownload must cast to an InputFileLocation', async () => {
  // GramJS can only derive a location from a MessageMediaDocument, not from a bare
  // Document. The fake client accepts anything, so it cannot catch this mismatch —
  // we have to ask GramJS's own getFileInfo.
  const { handle } = await tempFd(10)
  const document = new Api.Document({
    id: bigInt(123),
    accessHash: bigInt(456),
    fileReference: Buffer.alloc(8),
    date: 0,
    mimeType: 'application/octet-stream',
    size: bigInt(10),
    dcId: 2,
    attributes: [new Api.DocumentAttributeFilename({ fileName: 'ark.part0001' })],
  })
  const message = { id: 999, media: new Api.MessageMediaDocument({ document }) }
  const client = fakeClient(Buffer.alloc(10))

  await downloadToFile(client, message, handle.fd, { offset: 0 })
  await handle.close()

  const info = getFileInfo(client.calls[0].file)
  assert.equal(info.location.className, 'InputDocumentFileLocation')
  assert.equal(info.dcId, 2)
})

test('onProgress adds up to the right byte total', async () => {
  const { handle } = await tempFd(300)
  const client = fakeClient(Buffer.alloc(300), { partSize: 100 })
  const seen = []

  await downloadToFile(client, fakeMessage(300), handle.fd, { offset: 0, onProgress: (n) => seen.push(n) })

  await handle.close()
  assert.deepEqual(seen, [100, 100, 100])
})

test('gives a clear error when the message has no document', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient(Buffer.alloc(0))

  await assert.rejects(
    () => downloadToFile(client, { id: 42, media: null }, handle.fd, { offset: 0 }),
    /has no file attached/,
  )
  await handle.close()
})

test('gives a clear error when offset is not supplied', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient(Buffer.alloc(10))

  await assert.rejects(
    () => downloadToFile(client, fakeMessage(10), handle.fd, {}),
    /offset must be a finite number/,
  )
  await handle.close()
})

test('gives a clear error when offset is not a number', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient(Buffer.alloc(10))

  await assert.rejects(
    () => downloadToFile(client, fakeMessage(10), handle.fd, { offset: 'abc' }),
    /offset must be a finite number/,
  )
  await handle.close()
})

// A fake whose stream breaks partway through, the way one GetFile in a few thousand does.
// `failures` streams break; the ones after that run to the end. Every call records the
// offset it was asked to start at, which is what proves a retry resumes rather than restarts.
function flakyClient(content, { partSize = 100, failures = 1, failAfterParts = 2, error } = {}) {
  let left = failures

  return {
    calls: [],
    iterDownload(params) {
      this.calls.push(params)
      const from = Number(params.offset ?? 0)
      const breakAfter = left > 0 ? (left -= 1, failAfterParts) : Infinity

      return (async function* () {
        let sent = 0

        for (let at = from; at < content.length; at += partSize) {
          if (sent === breakAfter) {
            throw error ?? new Error('-503: Timeout (caused by upload.GetFile)')
          }
          yield content.subarray(at, at + partSize)
          sent += 1
        }
      })()
    },
  }
}

const instantRetry = { baseDelayMs: 0, sleep: async () => {} }

test('a transient error mid-stream is retried instead of ending the restore', async () => {
  const content = randomBytes(1000)
  const { file, handle } = await tempFd(1000)
  const client = flakyClient(content)

  const result = await downloadToFile(client, fakeMessage(1000), handle.fd, {
    offset: 0,
    retryOptions: instantRetry,
  })

  await handle.close()
  assert.equal(result.size, 1000)
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  assert.deepEqual(await fs.readFile(file), content)
})

test('the retry resumes at the byte it stopped on, it does not start the chunk again', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFd(1000)
  const client = flakyClient(content)
  const seen = []

  await downloadToFile(client, fakeMessage(1000), handle.fd, {
    offset: 0,
    onProgress: (n) => seen.push(n),
    retryOptions: instantRetry,
  })

  await handle.close()
  assert.equal(client.calls.length, 2, 'one broken stream, one resumed stream')
  assert.equal(Number(client.calls[1].offset), 200, 'the second stream starts where the first stopped')
  assert.equal(
    seen.reduce((a, b) => a + b, 0),
    1000,
    'no byte is counted twice',
  )
})

test('a chunk that does not start the file resumes at a document offset, not a file offset', async () => {
  // The document is the chunk: its byte 0 is the chunk's byte 0, whatever position the
  // chunk occupies in the assembled file. Resuming at `offset + written` would ask for a
  // part 500 bytes further into the document than the one that is actually missing.
  const content = randomBytes(1000)
  const { file, handle } = await tempFd(1500)
  const client = flakyClient(content)

  await downloadToFile(client, fakeMessage(1000), handle.fd, {
    offset: 500,
    retryOptions: instantRetry,
  })

  await handle.close()
  assert.equal(Number(client.calls[1].offset), 200, 'the stream resumes 200 bytes into the document')
  assert.deepEqual((await fs.readFile(file)).subarray(500), content, 'and lands 500 bytes into the file')
})

test('the resume offset is one GramJS itself accepts', async () => {
  // iterDownload does big-integer arithmetic on `offset` (offset.divide, offset.add), so a
  // plain JS number sails through the fake client and throws against the real one. Ask
  // GramJS rather than the fake: hand its own iterDownload the offset ours produced.
  const content = randomBytes(1000)
  const { handle } = await tempFd(1000)
  const client = flakyClient(content)

  await downloadToFile(client, fakeMessage(1000), handle.fd, { offset: 0, retryOptions: instantRetry })
  await handle.close()

  const document = new Api.Document({
    id: bigInt(123),
    accessHash: bigInt(456),
    fileReference: Buffer.alloc(8),
    date: 0,
    mimeType: 'application/octet-stream',
    size: bigInt(1000),
    dcId: 2,
    attributes: [new Api.DocumentAttributeFilename({ fileName: 'ark.part0001' })],
  })
  const logger = { info() {}, debug() {}, warn() {} }

  const iter = iterDownload(
    { _log: logger },
    { file: new Api.MessageMediaDocument({ document }), offset: client.calls[1].offset, requestSize: 512 * 1024 },
  )

  // A non-zero offset has to route through the iterator that can start mid-document;
  // the direct one only ever begins at zero.
  assert.equal(iter.constructor.name, 'GenericDownloadIter')
})

test('a stream that never gets anywhere gives up rather than retrying forever', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFd(1000)
  const client = flakyClient(content, { failures: Infinity, failAfterParts: 0 })

  await assert.rejects(
    () =>
      downloadToFile(client, fakeMessage(1000), handle.fd, {
        offset: 0,
        retryOptions: { ...instantRetry, attempts: 3 },
      }),
    /Timeout/,
  )

  await handle.close()
  assert.equal(client.calls.length, 3, 'the attempt budget is spent, and no more')
})

test('retries are announced so a long wait does not read as a hang', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFd(1000)
  const client = flakyClient(content)
  const retries = []

  await downloadToFile(client, fakeMessage(1000), handle.fd, {
    offset: 0,
    retryOptions: {
      ...instantRetry,
      onRetry: (err, attempt) => retries.push({ message: err.message, attempt }),
    },
  })

  await handle.close()
  assert.deepEqual(retries, [{ message: '-503: Timeout (caused by upload.GetFile)', attempt: 1 }])
})

test('the digest and the size describe the document, not whatever the stream yielded', async () => {
  // The fake streams everything it has, but the document says it is shorter. Hashing the
  // buffers as they arrive would digest bytes that are not part of this chunk at all.
  const content = randomBytes(1000)
  const { file, handle } = await tempFd(1000)
  const client = fakeClient(content, { partSize: 250 })

  const result = await downloadToFile(client, fakeMessage(750), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(result.size, 750)
  assert.equal(result.sha256, createHash('sha256').update(content.subarray(0, 750)).digest('hex'))
  assert.deepEqual((await fs.readFile(file)).subarray(0, 750), content.subarray(0, 750))
})

test('the digest covers the chunk range only, not its neighbours in the file', async () => {
  const content = randomBytes(500)
  const { file, handle } = await tempFd(1500)
  await handle.write(Buffer.alloc(500, 0xaa), 0, 500, 0)
  await handle.write(Buffer.alloc(500, 0xbb), 0, 500, 1000)

  const client = fakeClient(content)
  const result = await downloadToFile(client, fakeMessage(500), handle.fd, { offset: 500 })

  await handle.close()
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))

  const onDisk = await fs.readFile(file)
  assert.deepEqual(onDisk.subarray(0, 500), Buffer.alloc(500, 0xaa), 'the bytes before must survive')
  assert.deepEqual(onDisk.subarray(1000), Buffer.alloc(500, 0xbb), 'the bytes after must survive')
})

test('a chunk longer than one slice is fetched as several streams', async () => {
  const content = randomBytes(SLICE_SIZE + 1000)
  const { file, handle } = await tempFd(content.length)
  const client = fakeClient(content, { partSize: 512 * 1024 })

  const result = await downloadToFile(client, fakeMessage(content.length), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(client.calls.length, 2, 'one stream per slice')
  assert.deepEqual(client.calls.map((c) => Number(c.offset)), [0, SLICE_SIZE])
  assert.equal(result.size, content.length)
  assert.deepEqual(await fs.readFile(file), content)
})

test('every byte is covered exactly once, with no gap and no overlap', async () => {
  // Length alone cannot tell a gap from an overlap that happens to cancel it out. Give every
  // position a value derived from its own index and compare byte for byte.
  const length = SLICE_SIZE * 2 + 4096
  const content = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) content[i] = (i * 31) % 251

  const { file, handle } = await tempFd(length)
  const client = fakeClient(content, { partSize: 512 * 1024 })

  await downloadToFile(client, fakeMessage(length), handle.fd, { offset: 0 })

  await handle.close()
  assert.deepEqual(await fs.readFile(file), content)
})

test('the last slice is whatever is left, not a full slice', async () => {
  const content = randomBytes(SLICE_SIZE + 7)
  const { handle } = await tempFd(content.length)
  const client = fakeClient(content, { partSize: 512 * 1024 })
  const seen = []

  const result = await downloadToFile(client, fakeMessage(content.length), handle.fd, {
    offset: 0,
    onProgress: (n) => seen.push(n),
  })

  await handle.close()
  assert.equal(result.size, content.length)
  assert.equal(seen.reduce((a, b) => a + b, 0), content.length, 'no byte counted twice')
})

test('a slice that fails resumes at its own watermark', async () => {
  const content = randomBytes(SLICE_SIZE + 1000)
  const { file, handle } = await tempFd(content.length)
  let broken = false

  const client = {
    calls: [],
    iterDownload(params) {
      this.calls.push(params)
      const from = Number(params.offset ?? 0)
      const breakAfter = from === 0 && !broken ? ((broken = true), 2) : Infinity

      return (async function* () {
        let sent = 0
        for (let at = from; at < content.length; at += 512 * 1024) {
          if (sent === breakAfter) throw new Error('-503: Timeout (caused by upload.GetFile)')
          yield content.subarray(at, at + 512 * 1024)
          sent += 1
        }
      })()
    },
  }

  const result = await downloadToFile(client, fakeMessage(content.length), handle.fd, {
    offset: 0,
    retryOptions: { baseDelayMs: 0, sleep: async () => {} },
  })

  await handle.close()
  assert.equal(Number(client.calls[1].offset), 2 * 512 * 1024, 'it picks up where it stopped')
  assert.equal(result.size, content.length)
  assert.deepEqual(await fs.readFile(file), content)
})

test('a document with no size is refused rather than quietly downloaded as nothing', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient(randomBytes(10))

  await assert.rejects(
    () => downloadToFile(client, { id: 42, media: { document: { id: 'd' } } }, handle.fd, { offset: 0 }),
    /no usable size/,
  )
  await handle.close()
})

test('a stream that ends short of the slice boundary is retried, not accepted as done', async () => {
  // The document claims 1000 bytes but the stream always stops at 400. A short delivery
  // must not be waved through as a completed slice just because the stream ended cleanly.
  const content = randomBytes(1000)
  const { handle } = await tempFd(1000)
  const client = fakeClient(content.subarray(0, 400), { partSize: 100 })

  await assert.rejects(
    () =>
      downloadToFile(client, fakeMessage(1000), handle.fd, {
        offset: 0,
        retryOptions: { attempts: 2, baseDelayMs: 0, sleep: async () => {} },
      }),
    /ended after 400 of 1000 bytes/,
  )
  await handle.close()
  assert.equal(client.calls.length, 2, 'the short stream is retried up to the attempt budget')
})

test('a stream that delivers exactly the slice length still succeeds', async () => {
  const content = randomBytes(1000)
  const { file, handle } = await tempFd(1000)
  const client = fakeClient(content, { partSize: 100 })

  const result = await downloadToFile(client, fakeMessage(1000), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(result.size, 1000)
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  assert.deepEqual(await fs.readFile(file), content)
})
