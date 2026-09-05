import { createHash } from 'node:crypto'
import { write as writeCallback } from 'node:fs'
import { promisify } from 'node:util'

import { returnBigInt } from 'telegram/Helpers.js'

import { PART_SIZE } from './chunking.js'
import { withRetry } from './retry.js'

const write = promisify(writeCallback)

async function writeExactly(fd, buffer, position) {
  let written = 0

  while (written < buffer.length) {
    const { bytesWritten } = await write(fd, buffer, written, buffer.length - written, position + written)
    written += bytesWritten
  }
}

export async function downloadToFile(client, message, fd, { offset, onProgress, retryOptions } = {}) {
  const document = message?.media?.document

  if (!document) {
    throw new Error(`Message ${message?.id} has no file attached.`)
  }

  if (!Number.isFinite(offset)) {
    throw new Error(`offset must be a finite number, got: ${offset}`)
  }

  const hash = createHash('sha256')
  let written = 0

  // A chunk is thousands of separate part requests and any one of them can come back
  // -503, so a stream that breaks has to be picked up rather than abandoned — there is no
  // resume file for a download, and giving up throws away every byte fetched so far.
  // Restarting the iterator at `offset + written` is what makes that safe: bytes are
  // hashed in the order they are written and `written` only moves once a buffer has been
  // both written and hashed, so the resumed stream continues the same digest.
  //
  // The two offsets are not the same number and must not be confused: `written` is a
  // position inside the document, which is where the stream resumes, while `offset +
  // written` is a position inside the file being assembled, which is where the bytes land.
  // Every chunk after the first has a non-zero `offset`, so mixing them up reads the wrong
  // part of the document — caught by sha256, but only after re-downloading the whole chunk.
  async function streamFromWhereWeStopped() {
    for await (const buffer of client.iterDownload({
      file: message.media,
      offset: returnBigInt(written),
      requestSize: PART_SIZE,
    })) {
      await writeExactly(fd, buffer, offset + written)
      hash.update(buffer)
      written += buffer.length
      onProgress?.(buffer.length)
    }
  }

  // One attempt budget for the whole chunk would be the wrong unit: 1800MB is 3600 requests,
  // and five failures spread across them is a healthy download, not a broken one. So a budget
  // only ends the restore when it is spent without gaining a single byte. Every outer pass
  // must gain at least one byte to earn another, which is what bounds the loop.
  for (;;) {
    const before = written

    try {
      await withRetry(streamFromWhereWeStopped, retryOptions)
      break
    } catch (err) {
      if (written === before) throw err
    }
  }

  return { sha256: hash.digest('hex'), size: written }
}
