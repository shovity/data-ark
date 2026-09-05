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
import { connect as realConnect, requireChat } from '../client.js'
import { defaultConfigDir, loadConfig, saveConfig } from '../config.js'
import {
  buildManifest,
  chunkFileName,
  manifestFileName,
  newBackupId,
  serializeManifest,
} from '../manifest.js'
import { createProgress, formatBytes, formatDuration } from '../progress.js'
import { clearState, loadState, markChunkDone, saveState, stateDir, stateKey } from '../state.js'
import { uploadRange } from '../uploader.js'

// Above this threshold the wait must be spelled out, per spec §8.
const LONG_WAIT_MS = 60_000

async function realSendChunk(client, peer, { inputFile, fileName, caption }) {
  return await client.sendFile(peer, {
    file: inputFile,
    caption,
    forceDocument: true,
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
  })
}

async function realSendManifest(client, peer, { bytes, fileName, caption }) {
  return await client.sendFile(peer, {
    file: new CustomFile(fileName, bytes.length, '', bytes),
    caption,
    forceDocument: true,
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
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
  const chunkSize = options['chunk-size'] ? parseSize(options['chunk-size']) : DEFAULT_CHUNK_SIZE
  const concurrency = options.concurrency ? Number(options.concurrency) : DEFAULT_CONCURRENCY

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(
      `Invalid --concurrency: "${options.concurrency}". ` +
        `Must be an integer from 1 to ${MAX_CONCURRENCY} — each slot holds a 512KB part in RAM ` +
        'and Telegram answers with FLOOD_WAIT if too many requests go out at once.',
    )
  }

  const chunks = planChunks(stat.size, chunkSize)
  const key = stateKey(absPath, stat.size, stat.mtimeMs)

  let state = await loadState(key, configDir)
  const resuming = Boolean(state) && state.chunkSize === chunkSize

  if (resuming && state.chat !== String(chat)) {
    const stateFile = path.join(stateDir(configDir), `${key}.json`)
    throw new Error(
      `This unfinished backup is going to ${state.chat}, but the current command targets ${chat} — ` +
        `a single backup cannot be split across two destinations. Run again without --to to keep ` +
        `sending to ${state.chat}, or delete ${stateFile} and run again to start a new backup in ${chat}.`,
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
  }

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
  log(`To     ${chat}\n`)

  const client = await connect(config)

  try {
    for (const chunk of chunks) {
      if (state.done[String(chunk.i)]) {
        log(`Chunk ${chunk.i + 1}/${chunks.length} already uploaded, skipping.`)
        continue
      }

      const fileName = chunkFileName(state.id, chunk.i)
      const handle = await fs.open(absPath, 'r')

      const progress = silent
        ? { advance: () => {}, finish: () => {} }
        : createProgress({
            total: chunk.length,
            label: `Chunk ${chunk.i + 1}/${chunks.length}`,
            write: writeErr,
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
          caption: `#dataark ${state.id} ${chunk.i + 1}/${chunks.length}`,
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
      caption: `#dataark ${state.id} manifest`,
    })

    await clearState(key, configDir)

    log(`\nDone. Restore with:\n  npx data-ark restore ${state.id}`)

    return { id: state.id, chunks: chunks.length }
  } finally {
    // A failing disconnect must not swallow the real error already on its way up.
    try {
      await disconnect(client)
    } catch (err) {
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`)
    }
  }
}
