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
    throw new Error(`Invalid size: "${input}". Valid examples: 1800MB, 1.8GB, 524288.`)
  }

  const bytes = Math.floor(Number(match[1]) * UNITS[match[2] ?? 'b'])

  if (bytes <= 0) {
    throw new Error('Size must be greater than 0.')
  }

  if (bytes > MAX_CHUNK_SIZE) {
    throw new Error(
      'Maximum chunk size is 1950MB. Telegram accepts only 4000 parts of 512KB per file, ' +
        'an arithmetic ceiling of about 1953MB, so a safety margin is needed.',
    )
  }

  return bytes
}

export function planChunks(fileSize, chunkSize) {
  if (fileSize <= 0) {
    throw new Error('File is empty, nothing to upload.')
  }

  const chunks = []

  for (let offset = 0, i = 0; offset < fileSize; offset += chunkSize, i += 1) {
    chunks.push({ i, offset, length: Math.min(chunkSize, fileSize - offset) })
  }

  return chunks
}
