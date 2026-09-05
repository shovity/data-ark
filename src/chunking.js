export const PART_SIZE = 512 * 1024
export const MAX_PARTS = 4000
export const MAX_CHUNK_SIZE = 1950 * 1024 * 1024
export const DEFAULT_CHUNK_SIZE = 1800 * 1024 * 1024
export const DEFAULT_CONCURRENCY = 8
export const MAX_CONCURRENCY = 64

const UNITS = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
}

export function parseSize(input) {
  const text = String(input).trim().toLowerCase()
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/)

  if (!match) {
    throw new Error(`Kích thước không hợp lệ: "${input}". Ví dụ hợp lệ: 1800MB, 1.8GB, 524288.`)
  }

  const bytes = Math.floor(Number(match[1]) * UNITS[match[2] ?? 'b'])

  if (bytes <= 0) {
    throw new Error('Kích thước phải lớn hơn 0.')
  }

  if (bytes > MAX_CHUNK_SIZE) {
    throw new Error(
      'Chunk tối đa là 1950MB. Telegram chỉ nhận 4000 phần 512KB cho mỗi file, ' +
        'tức trần số học khoảng 1953MB, nên cần chừa biên an toàn.',
    )
  }

  return bytes
}

export function planChunks(fileSize, chunkSize) {
  if (fileSize <= 0) {
    throw new Error('File rỗng, không có gì để upload.')
  }

  const chunks = []

  for (let offset = 0, i = 0; offset < fileSize; offset += chunkSize, i += 1) {
    chunks.push({ i, offset, length: Math.min(chunkSize, fileSize - offset) })
  }

  return chunks
}
