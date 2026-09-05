import { createHash } from 'node:crypto'
import { write as writeCallback } from 'node:fs'
import { promisify } from 'node:util'

import { PART_SIZE } from './chunking.js'

const write = promisify(writeCallback)

async function writeExactly(fd, buffer, position) {
  let written = 0

  while (written < buffer.length) {
    const { bytesWritten } = await write(fd, buffer, written, buffer.length - written, position + written)
    written += bytesWritten
  }
}

export async function downloadToFile(client, message, fd, { offset, onProgress } = {}) {
  const document = message?.media?.document

  if (!document) {
    throw new Error(`Message ${message?.id} has no file attached.`)
  }

  if (!Number.isFinite(offset)) {
    throw new Error(`offset must be a finite number, got: ${offset}`)
  }

  const hash = createHash('sha256')
  let written = 0

  for await (const buffer of client.iterDownload({ file: message.media, requestSize: PART_SIZE })) {
    await writeExactly(fd, buffer, offset + written)
    hash.update(buffer)
    written += buffer.length
    onProgress?.(buffer.length)
  }

  return { sha256: hash.digest('hex'), size: written }
}
