import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import bigInt from 'big-integer'
import { Api } from 'telegram'
import { getFileInfo } from 'telegram/Utils.js'

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
  const file = path.join(dir, 'target.bin')
  const handle = await fs.open(file, 'w+')
  if (size) await handle.truncate(size)
  return { file, handle }
}

test('writes the content at the start of the file', async () => {
  const content = randomBytes(1500)
  const { file, handle } = await tempFd(1500)
  const client = fakeClient([content.subarray(0, 1000), content.subarray(1000)])

  const result = await downloadToFile(client, fakeMessage(), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(result.size, 1500)
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))
  assert.deepEqual(await fs.readFile(file), content)
})

test('writes at the right offset in the middle of the file', async () => {
  const head = Buffer.alloc(1000, 0)
  const content = randomBytes(500)
  const { file, handle } = await tempFd(1500)
  const client = fakeClient([content])

  await downloadToFile(client, fakeMessage(), handle.fd, { offset: 1000 })

  await handle.close()
  const onDisk = await fs.readFile(file)
  assert.deepEqual(onDisk.subarray(0, 1000), head)
  assert.deepEqual(onDisk.subarray(1000), content)
})

test("passes the message's media to iterDownload", async () => {
  const { handle } = await tempFd(10)
  const message = fakeMessage({ id: 'doc-abc' })
  const client = fakeClient([Buffer.alloc(10)])

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
  const client = fakeClient([Buffer.alloc(10)])

  await downloadToFile(client, message, handle.fd, { offset: 0 })
  await handle.close()

  const info = getFileInfo(client.calls[0].file)
  assert.equal(info.location.className, 'InputDocumentFileLocation')
  assert.equal(info.dcId, 2)
})

test('onProgress adds up to the right byte total', async () => {
  const { handle } = await tempFd(300)
  const client = fakeClient([Buffer.alloc(100), Buffer.alloc(100), Buffer.alloc(100)])
  const seen = []

  await downloadToFile(client, fakeMessage(), handle.fd, { offset: 0, onProgress: (n) => seen.push(n) })

  await handle.close()
  assert.deepEqual(seen, [100, 100, 100])
})

test('gives a clear error when the message has no document', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient([])

  await assert.rejects(
    () => downloadToFile(client, { id: 42, media: null }, handle.fd, { offset: 0 }),
    /has no file attached/,
  )
  await handle.close()
})

test('gives a clear error when offset is not supplied', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient([Buffer.alloc(10)])

  await assert.rejects(
    () => downloadToFile(client, fakeMessage(), handle.fd, {}),
    /offset must be a finite number/,
  )
  await handle.close()
})

test('gives a clear error when offset is not a number', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient([Buffer.alloc(10)])

  await assert.rejects(
    () => downloadToFile(client, fakeMessage(), handle.fd, { offset: 'abc' }),
    /offset must be a finite number/,
  )
  await handle.close()
})
