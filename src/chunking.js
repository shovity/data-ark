export const PART_SIZE = 512 * 1024
export const MAX_PARTS = 4000

// One slice is one short iterDownload stream. Small enough that a failed slice costs little
// and that there are far more slices than workers for the pool to balance across; big enough
// that the per-stream setup disappears against 16 parts of payload.
export const SLICE_SIZE = 8 * 1024 * 1024
export const MAX_CHUNK_SIZE = 1950 * 1024 * 1024
export const DEFAULT_CHUNK_SIZE = 1800 * 1024 * 1024
// Upload counts 512KB parts and download counts 8MB slices, so one number cannot serve both.
// Measured on a 1Gb/s line against a single 1800MB chunk, so every run transfers for three
// to five minutes rather than the seconds a burst benchmark samples — the distinction the
// parallel-download spec insists on, and it matters: measured in 20s bursts the download
// order came out reversed, with 4 apparently the fastest value.
//   upload     16 -> 7.7 MB/s (234s), 32 -> 9.4 (193s), 64 -> 9.5 (191s)
//   download    4 -> 5.8 MB/s (311s),  8 -> 6.0 (300s), 16 -> 6.0 (302s)
// Upload takes 32 because 64 measures the same speed (1% apart, inside the noise) at twice
// the cost: 64 puts 32MB in flight, and a batch's last part then needs 4.4 Mbps to land
// before the 60s stall deadline, against 2.1 Mbps at 32. A slow link would be told its
// transfer stalled while it was merely slow, which is the one thing that deadline must not say.
// Download takes 8 for the same reason from the other side: 16 buys nothing and 4 is slower.
export const DEFAULT_UPLOAD_CONCURRENCY = 32
export const DEFAULT_DOWNLOAD_CONCURRENCY = 8
export const MAX_CONCURRENCY = 64

// Every chunk is one message in the chat and one entry in the manifest, so a plan this long
// describes a backup nobody could use. At the 1950MB ceiling it allows a 19TB file; the only
// way to reach it is a chunk size picked by mistake, and reaching it by mistake means asking
// the loop below for billions of objects — an out-of-memory crash rather than an answer.
export const MAX_CHUNKS = 10_000

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

// How many chunks a file of this size splits into. planChunks builds them and parseManifest
// checks them against this same rule, so the layout has one definition, not three.
export function countChunks(fileSize, chunkSize) {
  return Math.ceil(fileSize / chunkSize)
}

export function planChunks(fileSize, chunkSize) {
  if (fileSize <= 0) {
    throw new Error('File is empty, nothing to upload.')
  }

  // `offset += chunkSize` has to advance or the loop below never reaches fileSize. Anything
  // that is not a whole number above zero either stands still or walks backwards, and the
  // caller gets a process that spins until it runs out of memory instead of an error. This
  // is reachable: an upload resuming from a state file takes chunkSize straight off disk.
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error(
      `Chunk size must be a whole number of bytes above zero, got: ${JSON.stringify(chunkSize)}.`,
    )
  }

  if (!Number.isSafeInteger(fileSize)) {
    throw new Error(`File size must be a whole number of bytes, got: ${JSON.stringify(fileSize)}.`)
  }

  // Counted before anything is built, so an impossible plan costs no memory.
  const count = countChunks(fileSize, chunkSize)

  if (count > MAX_CHUNKS) {
    throw new Error(
      `Splitting ${fileSize} bytes into ${chunkSize}-byte chunks needs ${count} chunks, ` +
        `and a backup holds at most ${MAX_CHUNKS} chunks.`,
    )
  }

  const chunks = []

  for (let offset = 0, i = 0; offset < fileSize; offset += chunkSize, i += 1) {
    chunks.push({ i, offset, length: Math.min(chunkSize, fileSize - offset) })
  }

  return chunks
}
