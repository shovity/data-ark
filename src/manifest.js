import { randomBytes } from 'node:crypto'

import { countChunks } from './chunking.js'

export const MANIFEST_VERSION = 1

export function newBackupId(now = new Date(), randomHex = () => randomBytes(3).toString('hex')) {
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return `ark-${yyyy}${mm}${dd}-${randomHex()}`
}

export function chunkFileName(id, i) {
  return `${id}.part${String(i + 1).padStart(4, '0')}`
}

export function manifestFileName(id) {
  return `${id}.manifest.json`
}

export function buildManifest({ id, name, size, chunkSize, chunks, createdAt = new Date().toISOString() }) {
  return {
    v: MANIFEST_VERSION,
    id,
    name,
    size,
    chunkSize,
    createdAt,
    chunks: [...chunks]
      .sort((a, b) => a.i - b.i)
      .map(({ i, msgId, size: chunkBytes, sha256 }) => ({ i, msgId, size: chunkBytes, sha256 })),
  }
}

export function serializeManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export function parseManifest(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input)

  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error('Cannot read manifest: content is not valid JSON.')
  }

  if (manifest.v !== MANIFEST_VERSION) {
    throw new Error(
      `Manifest uses version ${manifest.v}, this build of data-ark only understands version ${MANIFEST_VERSION}.`,
    )
  }

  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error('Manifest has no chunk list.')
  }

  // The manifest comes off a chat, so nothing in it is trusted. The checks below are
  // arithmetic on these numbers, and arithmetic on a string or a null does not fail — it
  // produces a comparison that rejects the manifest for the wrong reason. A string size used
  // to be reported as "add up to 100, but the manifest records a file size of 100", which
  // sends the reader hunting for a difference that is not there.
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) {
    throw new Error(
      `Manifest records a file size of ${JSON.stringify(manifest.size)}, ` +
        'which is not a whole number of bytes.',
    )
  }

  if (!Number.isSafeInteger(manifest.chunkSize) || manifest.chunkSize < 1) {
    throw new Error(
      `Manifest records a chunk size of ${JSON.stringify(manifest.chunkSize)}, ` +
        'which is not a whole number of bytes above zero.',
    )
  }

  manifest.chunks.forEach((chunk, index) => {
    if (typeof chunk !== 'object' || chunk === null) {
      throw new Error(
        `Manifest entry for chunk ${index + 1} is not an object: ${JSON.stringify(chunk)}.`,
      )
    }

    if (!Number.isSafeInteger(chunk.size) || chunk.size < 0) {
      throw new Error(
        `Manifest records ${JSON.stringify(chunk.size)} bytes for chunk ${index + 1}, ` +
          'which is not a whole number of bytes.',
      )
    }

    if (chunk.i !== index) {
      throw new Error(`Manifest is missing chunk ${index}: the chunk list is not contiguous.`)
    }
  })

  const expectedChunks = countChunks(manifest.size, manifest.chunkSize)
  if (manifest.chunks.length !== expectedChunks) {
    throw new Error(`Manifest is missing ${expectedChunks - manifest.chunks.length} chunk(s).`)
  }

  const total = manifest.chunks.reduce((sum, chunk) => sum + chunk.size, 0)
  if (total !== manifest.size) {
    throw new Error(
      `Chunk sizes add up to ${total}, but the manifest records a file size of ${manifest.size}.`,
    )
  }

  // Restore writes chunk i at exactly offset i * chunkSize, so the layout must be
  // uniform: every chunk is chunkSize, except the last one which is the remainder.
  // A correct total with individually wrong sizes yields a file with a hole or
  // extra length while every per-chunk sha256 still matches — silently wrong data,
  // precisely what data-ark must never produce.
  manifest.chunks.forEach((chunk, index) => {
    const expected = Math.min(manifest.chunkSize, manifest.size - index * manifest.chunkSize)
    if (chunk.size !== expected) {
      throw new Error(
        `Manifest records ${chunk.size} bytes for chunk ${index + 1}, but a layout of ` +
          `${manifest.chunkSize} bytes per chunk requires ${expected} bytes. ` +
          'This manifest describes the wrong chunk positions; restoring it would produce a corrupt file.',
      )
    }
  })

  return manifest
}
