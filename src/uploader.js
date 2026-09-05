import { createHash, randomBytes } from 'node:crypto'
import { read as readCallback } from 'node:fs'
import { promisify } from 'node:util'

import { Api } from 'telegram'
import { readBigIntFromBuffer } from 'telegram/Helpers.js'

import { DEFAULT_CONCURRENCY, PART_SIZE, MAX_PARTS } from './chunking.js'
import { withRetry } from './retry.js'

const read = promisify(readCallback)

// Telegram tách hai API upload theo kích thước file: trên 10MB mới được dùng
// nhóm "big". GramJS chọn đúng ngưỡng này (LARGE_FILE_THRESHOLD trong
// node_modules/telegram/client/uploads.js), data-ark bám theo.
export const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024

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
    concurrency = DEFAULT_CONCURRENCY,
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

  const isLarge = length > LARGE_FILE_THRESHOLD
  const fileId = readBigIntFromBuffer(randomBytes(8), true, true)
  const hash = createHash('sha256')

  function partRequest(part, bytes) {
    if (isLarge) {
      return new Api.upload.SaveBigFilePart({
        fileId,
        filePart: part,
        fileTotalParts: totalParts,
        bytes,
      })
    }

    return new Api.upload.SaveFilePart({ fileId, filePart: part, bytes })
  }

  for (let start = 0; start < totalParts; start += concurrency) {
    const end = Math.min(start + concurrency, totalParts)
    const sending = []
    let sendError = null
    let readError = null

    // Đọc tuần tự để hash đúng thứ tự, gửi song song.
    try {
      for (let part = start; part < end; part += 1) {
        const partOffset = part * partSize
        const partLength = Math.min(partSize, length - partOffset)
        const bytes = await readExactly(fd, partLength, offset + partOffset)

        hash.update(bytes)

        // Gắn handler ngay lúc tạo promise, không đợi Promise.all ở cuối lô:
        // nếu readExactly ném ở part sau, một promise đã push mà chưa ai bắt sẽ
        // nổ thành unhandledRejection và che mất lỗi thật.
        sending.push(
          withRetry(() => client.invoke(partRequest(part, bytes)), retryOptions).then(
            () => onProgress?.(partLength),
            (err) => {
              sendError ??= err
            },
          ),
        )
      }
    } catch (err) {
      readError = err
    }

    // Mọi promise trong sending đều đã tự nuốt lỗi ở trên nên luôn resolve;
    // await ở đây chỉ để chắc chắn không còn request nào đang bay khi ném lỗi.
    await Promise.all(sending)

    if (readError) throw readError
    if (sendError) throw sendError
  }

  const inputFile = isLarge
    ? new Api.InputFileBig({ id: fileId, parts: totalParts, name: fileName })
    : new Api.InputFile({ id: fileId, parts: totalParts, name: fileName, md5Checksum: '' })

  return {
    inputFile,
    sha256: hash.digest('hex'),
    parts: totalParts,
  }
}
