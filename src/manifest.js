import { randomBytes } from 'node:crypto'

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
    throw new Error('Không đọc được manifest: nội dung không phải JSON hợp lệ.')
  }

  if (manifest.v !== MANIFEST_VERSION) {
    throw new Error(
      `Manifest dùng phiên bản ${manifest.v}, bản data-ark này chỉ hiểu phiên bản ${MANIFEST_VERSION}.`,
    )
  }

  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error('Manifest thiếu danh sách chunk.')
  }

  manifest.chunks.forEach((chunk, index) => {
    if (chunk.i !== index) {
      throw new Error(`Manifest thiếu chunk số ${index}: danh sách chunk không liên tục.`)
    }
  })

  const expectedChunks = Math.ceil(manifest.size / manifest.chunkSize)
  if (manifest.chunks.length !== expectedChunks) {
    throw new Error(`Manifest thiếu ${expectedChunks - manifest.chunks.length} chunk(s).`)
  }

  const total = manifest.chunks.reduce((sum, chunk) => sum + chunk.size, 0)
  if (total !== manifest.size) {
    throw new Error(
      `Tổng kích thước các chunk (${total}) không khớp kích thước file trong manifest (${manifest.size}).`,
    )
  }

  return manifest
}
