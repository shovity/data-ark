import { promises as fs } from 'node:fs'
import path from 'node:path'

import { Api } from 'telegram'
import { CustomFile } from 'telegram/client/uploads.js'

import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  PART_SIZE,
  parseSize,
  planChunks,
} from '../chunking.js'
import { chunkCaption, manifestCaption } from '../caption.js'
import { closeQuietly, connect as realConnect, describeChat, requireChat } from '../client.js'
import { defaultConfigDir, loadConfig, saveConfig } from '../config.js'
import {
  buildManifest,
  chunkFileName,
  manifestFileName,
  newBackupId,
  serializeManifest,
} from '../manifest.js'
import { createProgress, formatBytes, formatDuration } from '../progress.js'
import {
  MAX_STATES,
  clearState,
  loadState,
  markChunkDone,
  pruneStates,
  saveState,
  stateFile,
  stateKey,
} from '../state.js'
import { uploadRange } from '../uploader.js'

// Above this threshold the wait must be spelled out, per spec §8.
const LONG_WAIT_MS = 60_000

// Chunks and manifests differ only in where the bytes come from. Everything Telegram is
// told about them — document, not preview; this exact file name — is decided once.
async function sendDocument(client, peer, { file, fileName, caption }) {
  return await client.sendFile(peer, {
    file,
    caption,
    forceDocument: true,
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
  })
}

async function realSendChunk(client, peer, { inputFile, fileName, caption }) {
  return await sendDocument(client, peer, { file: inputFile, fileName, caption })
}

async function realSendManifest(client, peer, { bytes, fileName, caption }) {
  return await sendDocument(client, peer, {
    file: new CustomFile(fileName, bytes.length, '', bytes),
    fileName,
    caption,
  })
}

export async function runUpload(filePath, options = {}, deps = {}) {
  const {
    connect = realConnect,
    sendChunk = realSendChunk,
    sendManifest = realSendManifest,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    partSize = PART_SIZE,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    silent = false,
    onBackupId = () => {},
  } = deps

  const absPath = path.resolve(filePath)

  let stat
  try {
    stat = await fs.stat(absPath)
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`File does not exist: ${absPath}`)
    throw err
  }

  if (!stat.isFile()) {
    throw new Error(`${absPath} is not a file.`)
  }

  const config = await loadConfig(configDir)
  const chat = requireChat(options, config)
  const requestedChunkSize = options['chunk-size'] ? parseSize(options['chunk-size']) : null
  const concurrency = options.concurrency ? Number(options.concurrency) : DEFAULT_CONCURRENCY

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(
      `Invalid --concurrency: "${options.concurrency}". ` +
        `Must be an integer from 1 to ${MAX_CONCURRENCY} — each slot holds a 512KB part in RAM ` +
        'and Telegram answers with FLOOD_WAIT if too many requests go out at once.',
    )
  }

  const key = stateKey(absPath, stat.size, stat.mtimeMs)

  let state = await loadState(key, configDir)

  // The chunks already in the chat were cut at the size this backup started with, and
  // nothing can re-cut them. Carrying on at a different size would abandon every one of
  // them in the chat, where data-ark can no longer find them — so an unfinished backup
  // keeps its own chunk size, and a flag that disagrees is refused rather than obeyed.
  if (state && requestedChunkSize !== null && requestedChunkSize !== state.chunkSize) {
    const file = stateFile(key, configDir)
    throw new Error(
      `This unfinished backup is cut into ${formatBytes(state.chunkSize)} chunks, but ` +
        `--chunk-size asks for ${formatBytes(requestedChunkSize)} — the chunks already in ` +
        `${state.chat} cannot be re-cut. Run again without --chunk-size to carry on, or delete ` +
        `${file} and run again to start a new backup, which leaves the chunks already sent ` +
        'sitting in the chat with nothing to point at them.',
    )
  }

  const chunkSize = state ? state.chunkSize : (requestedChunkSize ?? DEFAULT_CHUNK_SIZE)
  const chunks = planChunks(stat.size, chunkSize)
  const resuming = Boolean(state)

  if (resuming && state.chat !== String(chat)) {
    const file = stateFile(key, configDir)
    throw new Error(
      `This unfinished backup is going to ${state.chat}, but the current command targets ${chat} — ` +
        `a single backup cannot be split across two destinations. Run again without --to to keep ` +
        `sending to ${state.chat}, or delete ${file} and run again to start a new backup in ${chat}.`,
    )
  }

  if (options.to) {
    await saveConfig({ ...config, defaultChat: String(chat) }, configDir)
  }

  if (!resuming) {
    state = {
      id: newBackupId(),
      chat: String(chat),
      path: absPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      chunkSize,
      done: {},
    }
    await saveState(key, state, configDir)

    // Only a new backup adds to the directory, so this is the one place it can grow.
    // The report goes out even when the caller asked for silence: this is not narration
    // about a transfer, it is data-ark dropping the only record of someone else's chunks.
    for (const gone of await pruneStates(configDir)) {
      writeErr(
        `\nDropped the record of unfinished backup ${gone.id}: data-ark keeps the ` +
          `${MAX_STATES} most recent. The chunks it sent are still in ${gone.chat}, ` +
          'searchable by that id, but that backup can no longer be resumed.\n',
      )
    }
  }

  onBackupId(state.id)

  const log = silent ? () => {} : (line) => console.log(line)
  const warn = silent ? () => {} : writeErr

  // Retries and FLOOD_WAIT must be announced: a silent FLOOD_WAIT_3600 leaves the user
  // staring at a frozen progress bar for an hour, assuming the process has hung.
  function onRetry(err, attempt, delayMs) {
    if (delayMs > LONG_WAIT_MS) {
      warn(
        `\nTelegram wants ${formatDuration(delayMs / 1000)} of waiting before the next send ` +
          `(${err.message}). data-ark is waiting and will carry on by itself, leave it running.\n`,
      )
      return
    }

    warn(
      `\nTemporary error (${err.message}), retry ${attempt} in ` +
        `${formatDuration(delayMs / 1000)}.\n`,
    )
  }

  log(`Backup ${state.id}`)
  log(`File   ${absPath} (${formatBytes(stat.size)}, ${chunks.length} chunks)`)
  log(`To     ${describeChat(chat)}\n`)

  const client = await connect(config, { verbose: options.verbose })

  try {
    for (const chunk of chunks) {
      if (state.done[String(chunk.i)]) {
        log(`Chunk ${chunk.i + 1}/${chunks.length} already uploaded, skipping.`)
        continue
      }

      const fileName = chunkFileName(state.id, chunk.i)
      const handle = await fs.open(absPath, 'r')

      // warn is already the no-op when silent, and createProgress draws through nothing else.
      const progress = createProgress({
        total: chunk.length,
        label: `Chunk ${chunk.i + 1}/${chunks.length}`,
        write: warn,
      })

      try {
        const { inputFile, sha256 } = await uploadRange(client, handle.fd, {
          offset: chunk.offset,
          length: chunk.length,
          fileName,
          concurrency,
          partSize,
          onProgress: (bytes) => progress.advance(bytes),
          retryOptions: { ...retryOptions, onRetry },
        })

        progress.finish()

        const message = await sendChunk(client, chat, {
          inputFile,
          fileName,
          caption: chunkCaption({ id: state.id, number: chunk.i + 1, total: chunks.length }),
        })

        state = await markChunkDone(
          key,
          state,
          chunk.i,
          { msgId: message.id, size: chunk.length, sha256 },
          configDir,
        )
      } finally {
        await handle.close()
      }
    }

    // The file can be overwritten mid-upload — with a 50GB file an hour passes between
    // the first and last chunk. The manifest would then describe a hybrid file that never
    // existed: restore still matches every sha256, but the data is garbage.
    const after = await fs.stat(absPath)

    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error(
        `${absPath} changed during the upload ` +
          `(size ${stat.size} → ${after.size}, mtime ${stat.mtimeMs} → ${after.mtimeMs}). ` +
          'This backup mixes old and new data and cannot be trusted — data-ark is not sending the manifest. ' +
          'Wait until the file settles, then run again to create a new backup.',
      )
    }

    const manifest = buildManifest({
      id: state.id,
      name: path.basename(absPath),
      size: stat.size,
      chunkSize,
      chunks: chunks.map((chunk) => ({ i: chunk.i, ...state.done[String(chunk.i)] })),
    })

    await sendManifest(client, chat, {
      bytes: serializeManifest(manifest),
      fileName: manifestFileName(state.id),
      caption: manifestCaption({
        id: manifest.id,
        name: manifest.name,
        size: manifest.size,
        chunks: manifest.chunks.length,
        createdAt: manifest.createdAt,
      }),
    })

    await clearState(key, configDir)

    log(`\nDone. Restore with:\n  npx data-ark restore ${state.id}`)

    return { id: state.id, chunks: chunks.length }
  } finally {
    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}
