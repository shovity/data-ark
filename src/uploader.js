import { createHash, randomBytes } from 'node:crypto'
import { read as readCallback } from 'node:fs'
import { promisify } from 'node:util'

import { Api } from 'telegram'
import { readBigIntFromBuffer } from 'telegram/Helpers.js'

import { PART_SIZE, MAX_PARTS } from './chunking.js'
import { withRetry } from './retry.js'

const read = promisify(readCallback)

async function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length)
  let filled = 0

  while (filled < length) {
    const { bytesRead } = await read(fd, buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) {
      throw new Error(`Đọc hụt: cần ${length} byte từ vị trí ${position} nhưng file đã hết.`)
    }
    filled += bytesRead
  }

  return buffer
}

export async function uploadRange(client, fd, options) {
  const {
    offset,
    length,
    fileName,
    concurrency = 8,
    partSize = PART_SIZE,
    onProgress,
    retryOptions,
  } = options

  const totalParts = Math.ceil(length / partSize)

  if (totalParts > MAX_PARTS) {
    throw new Error(
      `Dải byte này cần ${totalParts} phần, trong khi Telegram chỉ nhận tối đa 4000 phần mỗi file.`,
    )
  }

  const fileId = readBigIntFromBuffer(randomBytes(8), true, true)
  const hash = createHash('sha256')

  for (let start = 0; start < totalParts; start += concurrency) {
    const end = Math.min(start + concurrency, totalParts)
    const sending = []

    // Đọc tuần tự để hash đúng thứ tự, gửi song song.
    for (let part = start; part < end; part += 1) {
      const partOffset = part * partSize
      const partLength = Math.min(partSize, length - partOffset)
      const bytes = await readExactly(fd, partLength, offset + partOffset)

      hash.update(bytes)

      sending.push(
        withRetry(
          () =>
            client.invoke(
              new Api.upload.SaveBigFilePart({
                fileId,
                filePart: part,
                fileTotalParts: totalParts,
                bytes,
              }),
            ),
          retryOptions,
        ).then(() => onProgress?.(partLength)),
      )
    }

    await Promise.all(sending)
  }

  return {
    inputFile: new Api.InputFileBig({ id: fileId, parts: totalParts, name: fileName }),
    sha256: hash.digest('hex'),
    parts: totalParts,
  }
}
