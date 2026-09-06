import { promises as fs } from 'node:fs'
import path from 'node:path'

import { Api } from 'telegram'
import { CustomFile } from 'telegram/client/uploads.js'

import { PART_SIZE, planChunks } from '../chunking.js'
import { chunkCaption, manifestCaption } from '../caption.js'
import { describeChat } from '../chat.js'
import { closeQuietly, connect as realConnect } from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { requireChat, resolveSettings } from '../settings.js'
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

// A transient error that resolves itself on the next try is not news, and one line per
// occurrence buries the progress bar in a wall of text. Stay quiet until the third retry:
// by then the trouble has outlived two backoffs and is worth saying out loud.
const ANNOUNCE_AFTER_ATTEMPT = 3

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
    log: writeLog = (line) => console.log(line),
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
  const { values: settings, source } = resolveSettings(options, config, {
    file: configFile(configDir),
  })
  const chat = requireChat(settings)
  const concurrency = settings.concurrency

  const key = stateKey(absPath, stat.size, stat.mtimeMs)

  let state = await loadState(key, configDir)

  // The chunks already in the chat were cut at the size this backup started with, and
  // nothing can re-cut them. Carrying on at a different size would abandon every one of
  // them in the chat, where telark can no longer find them — so an unfinished backup
  // keeps its own chunk size, and a flag that disagrees is refused rather than obeyed.
  //
  // Only a flag is a disagreement. A configured chunkSize says what to use when nobody asks
  // for anything, and this run asked for nothing — so the backup quietly keeps its own size
  // rather than being refused over a preference set weeks ago for other files.
  if (state && source('chunkSize') === 'flag' && settings.chunkSize !== state.chunkSize) {
    const file = stateFile(key, configDir)
    throw new Error(
      `This unfinished backup is cut into ${formatBytes(state.chunkSize)} chunks, but ` +
        `--chunk-size asks for ${formatBytes(settings.chunkSize)} — the chunks already in ` +
        `${state.chat} cannot be re-cut. Run again without --chunk-size to carry on, or delete ` +
        `${file} and run again to start a new backup, which leaves the chunks already sent ` +
        'sitting in the chat with nothing to point at them.',
    )
  }

  const chunkSize = state ? state.chunkSize : settings.chunkSize

  // A resumed upload takes its chunk size off disk, and nothing validated that file on the
  // way in. planChunks will refuse an unusable one, but its message is about chunk sizes and
  // would send the reader looking for a --chunk-size flag they never passed.
  if (state && (!Number.isSafeInteger(chunkSize) || chunkSize < 1)) {
    throw new Error(
      `The record of this unfinished backup gives a chunk size of ${JSON.stringify(chunkSize)}, ` +
        `which cannot be used. ${stateFile(key, configDir)} is damaged — delete it and run ` +
        'again to start a new backup, which leaves the chunks already sent sitting in the ' +
        'chat with nothing to point at them.',
    )
  }

  const chunks = planChunks(stat.size, chunkSize)
  const resuming = Boolean(state)

  // Naming the way back rather than a flag to drop: the destination may have come from the
  // command line or from the stored setting, and "run again without --to" is no help to
  // someone who never typed one. Pointing at the chat itself is right either way.
  if (resuming && state.chat !== String(chat)) {
    const file = stateFile(key, configDir)
    throw new Error(
      `This unfinished backup is going to ${state.chat}, but the current command targets ${chat} — ` +
        `a single backup cannot be split across two destinations. Run again with ` +
        `--to ${state.chat} to carry on sending there, or delete ${file} and run again to ` +
        `start a new backup in ${chat}.`,
    )
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
    // about a transfer, it is telark dropping the only record of someone else's chunks.
    for (const gone of await pruneStates(configDir)) {
      writeErr(
        `\nDropped the record of unfinished backup ${gone.id}: telark keeps the ` +
          `${MAX_STATES} most recent. The chunks it sent are still in ${gone.chat}, ` +
          'searchable by that id, but that backup can no longer be resumed.\n',
      )
    }
  }

  onBackupId(state.id)

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  // Retries and FLOOD_WAIT must be announced: a silent FLOOD_WAIT_3600 leaves the user
  // staring at a frozen progress bar for an hour, assuming the process has hung.
  function onRetry(err, attempt, delayMs, elapsedMs = 0) {
    if (delayMs > LONG_WAIT_MS) {
      warn(
        `\nTelegram wants ${formatDuration(delayMs / 1000)} of waiting before the next send ` +
          `(${err.message}). telark is waiting and will carry on by itself, leave it running.\n`,
      )
      return
    }

    // The exception to staying quiet: an attempt that took a minute to fail spent that
    // minute with the bar frozen, which is exactly what a hang looks like. Those are worth
    // a line the first time, whatever the attempt number.
    if (attempt < ANNOUNCE_AFTER_ATTEMPT && elapsedMs < LONG_WAIT_MS) return

    warn(
      `\nTemporary error (${err.message}), retry ${attempt} in ` +
        `${formatDuration(delayMs / 1000)}.\n`,
    )
  }

  log(`Backup ${state.id}`)
  log(`File   ${absPath} (${formatBytes(stat.size)}, ${chunks.length} chunks)`)
  log(`To     ${describeChat(chat)}\n`)

  const client = await connect(config, { verbose: settings.verbose })

  try {
    // Everything already in the chat is reported before the bar exists. These lines go to
    // stdout while the bar is rewritten on stderr with \r, so printed from inside the loop
    // they would land straight on the line the bar keeps returning to.
    const pending = []

    for (const chunk of chunks) {
      if (state.done[String(chunk.i)]) {
        log(`Chunk ${chunk.i + 1}/${chunks.length} already uploaded, skipping.`)
        continue
      }

      pending.push(chunk)
    }

    // A run that only failed to send the manifest has every chunk done and nothing left to
    // transfer: no bar at all, rather than one that springs into existence at 100%.
    if (pending.length > 0) {
      const remaining = pending.reduce((sum, chunk) => sum + chunk.length, 0)

      // One bar for the whole upload: the label names the chunk in flight, everything else
      // describes the file. Chunks a previous run sent count towards the bar but not towards
      // the speed, so an hour-old chunk cannot inflate the ETA of the ones still to go.
      // warn is already the no-op when silent, and createProgress draws through nothing else.
      const progress = createProgress({
        total: stat.size,
        done: stat.size - remaining,
        label: `Chunk ${pending[0].i + 1}/${chunks.length}`,
        write: warn,
      })

      try {
        for (const chunk of pending) {
          progress.setLabel(`Chunk ${chunk.i + 1}/${chunks.length}`)

          const fileName = chunkFileName(state.id, chunk.i)
          const handle = await fs.open(absPath, 'r')

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
      } finally {
        // Same reason as restore: a send that fails must not leave "Error: ..." printed over
        // the bar's own line.
        progress.finish()
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
          'This backup mixes old and new data and cannot be trusted — telark is not sending the manifest. ' +
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

    log(`\nDone. Restore with:\n  npx telark restore ${state.id}`)

    return { id: state.id, chunks: chunks.length }
  } finally {
    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}
