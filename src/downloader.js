import { createHash } from 'node:crypto'
import { read as readCallback, write as writeCallback } from 'node:fs'
import { promisify } from 'node:util'

import { returnBigInt } from 'telegram/Helpers.js'

import { PART_SIZE, SLICE_SIZE } from './chunking.js'
import { withRetry } from './retry.js'

const write = promisify(writeCallback)
const read = promisify(readCallback)

// Read back in far bigger bites than the 512KB the network hands us: this loop is pure disk.
const HASH_READ_SIZE = 4 * 1024 * 1024

async function writeExactly(fd, buffer, position) {
  let written = 0

  while (written < buffer.length) {
    const { bytesWritten } = await write(fd, buffer, written, buffer.length - written, position + written)
    written += bytesWritten
  }
}

async function readExactly(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0

  while (filled < length) {
    const { bytesRead } = await read(fd, buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) {
      throw new Error(`Short read: needed ${length} bytes at offset ${position} but the file ended.`)
    }
    filled += bytesRead
  }

  return buffer
}

// The digest is taken from the assembled range on disk rather than from the buffers as they
// arrive. Once slices land out of order that is the only order left to hash in, and it is
// the better check anyway: a slice written at the wrong offset, two slices overlapping, or
// one silently skipped all show up here. It does not prove the bytes reached the platter —
// this read may well be served from the page cache — it proves the assembly.
async function hashRange(fd, offset, length) {
  const hash = createHash('sha256')

  for (let at = 0; at < length; at += HASH_READ_SIZE) {
    hash.update(await readExactly(fd, Math.min(HASH_READ_SIZE, length - at), offset + at))
  }

  return hash.digest('hex')
}

export async function downloadToFile(client, message, fd, { offset, onProgress, retryOptions } = {}) {
  const document = message?.media?.document

  if (!document) {
    throw new Error(`Message ${message?.id} has no file attached.`)
  }

  if (!Number.isFinite(offset)) {
    throw new Error(`offset must be a finite number, got: ${offset}`)
  }

  // Telegram's own record of how long the document is. Taking the length from the caller
  // instead would make runRestore's size check compare the manifest against itself.
  const size = returnBigInt(document.size ?? 0).toJSNumber()

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Message ${message?.id} has a document with no usable size.`)
  }

  const sliceCount = Math.ceil(size / SLICE_SIZE)

  // One slice is one short stream. `done` lives outside withRetry, so a retried slice picks
  // up at its own watermark instead of fetching again what it already has.
  //
  // The two offsets are not the same number: `start + done` is a position inside the
  // document, which is where the stream resumes, while `offset + start + done` is a position
  // inside the file being assembled, which is where the bytes land.
  async function downloadSlice(index) {
    const start = index * SLICE_SIZE
    const length = Math.min(SLICE_SIZE, size - start)
    let done = 0

    await withRetry(async () => {
      for await (const buffer of client.iterDownload({
        file: message.media,
        offset: returnBigInt(start + done),
        requestSize: PART_SIZE,
      })) {
        // The stream runs to the end of the document; this slice stops at its own boundary.
        const take = Math.min(buffer.length, length - done)

        await writeExactly(fd, buffer.subarray(0, take), offset + start + done)
        done += take
        onProgress?.(take)

        if (done >= length) break
      }

      // A stream that ends before the slice's own boundary is a short delivery, not a
      // completed slice — without this, a hole here would surface only as a digest
      // mismatch, telling the user their data is corrupt when it was simply cut short.
      // Checked inside the retried callback so a transient short stream is retried, and a
      // stream that yields nothing at all still counts as a failure worth retrying.
      if (done < length) {
        throw new Error(
          `Slice ${index + 1}/${sliceCount} of message ${message?.id} ended after ${done} of ${length} bytes.`,
        )
      }
    }, retryOptions)
  }

  for (let index = 0; index < sliceCount; index += 1) {
    await downloadSlice(index)
  }

  return { sha256: await hashRange(fd, offset, size), size }
}
