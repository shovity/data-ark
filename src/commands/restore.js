import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  closeQuietly,
  connect as realConnect,
  findManifestMessage,
  readMessageBytes as realReadMessageBytes,
} from '../client.js'
import { askConfirm } from '../confirm.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { assertLoggedIn } from '../session.js'
import { requireChat, resolveSettings } from '../settings.js'
import { downloadToFile } from '../downloader.js'
import { parseManifest } from '../manifest.js'
import { createProgress, formatBytes, formatDuration } from '../progress.js'

// Anything past a minute of waiting needs saying out loud; below that the pause is shorter
// than the time a user would spend wondering about it.
const LONG_WAIT_MS = 60_000

// A transient error that resolves itself on the next try is not news, and one line per
// occurrence buries the progress bar in a wall of text. Stay quiet until the third retry:
// by then the trouble has outlived two backoffs and is worth saying out loud.
const ANNOUNCE_AFTER_ATTEMPT = 3

async function realGetMessage(client, peer, msgId) {
  const [message] = await client.getMessages(peer, { ids: [msgId] })
  return message ?? null
}

export async function realDownloadChunk(client, message, handle, offset, onProgress, options) {
  return await downloadToFile(client, message, handle.fd, { offset, onProgress, ...options })
}

// manifest.name comes from data downloaded off Telegram — don't trust it when picking
// a path ourselves. path.basename stops "../../x" but still returns "..", "." or "" for
// a few pathological names: path.resolve('..') is the parent directory, so a multi-GB
// .partial file would land outside the current directory and only blow up at rename.
function safeOutName(name) {
  const base = path.basename(String(name ?? ''))

  if (base === '' || base === '.' || base === '..') {
    throw new Error(
      `The name in the manifest ("${name}") cannot be used as a file name. ` +
        'Run again with --out <path> to choose where to write.',
    )
  }

  return base
}

export async function runRestore(backupId, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = findManifestMessage,
    readMessageBytes = realReadMessageBytes,
    getMessage = realGetMessage,
    downloadChunk = realDownloadChunk,
    confirm = askConfirm,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
  } = deps

  const config = await loadConfig(configDir)
  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  const chat = requireChat(settings)
  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  // A restore keeps no progress file, so a part that comes back -503 is retried rather than
  // thrown away — and a retry nobody is told about is indistinguishable from a hung transfer,
  // because the progress bar simply stops moving while the wait runs.
  function onRetry(err, attempt, delayMs, elapsedMs = 0) {
    if (delayMs > LONG_WAIT_MS) {
      warn(
        `\nTelegram wants ${formatDuration(delayMs / 1000)} of waiting before the next part ` +
          `(${err.message}). telstore is waiting and will carry on by itself, leave it running.\n`,
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

  const client = await connect(config, { verbose: settings.verbose })

  try {
    const manifestMessage = await searchManifest(client, chat, backupId)

    if (!manifestMessage) {
      throw new Error(
        `No manifest found for ${backupId} in ${chat}. ` +
          'Check the backup id, or use --chat to point at the right chat.',
      )
    }

    const manifest = parseManifest(await readMessageBytes(client, manifestMessage))
    // When the user passes --out, respect that path verbatim.
    const target = path.resolve(options.out ?? safeOutName(manifest.name))
    const partial = `${target}.partial`

    // Only ENOENT means "no file yet". Treating a permission or I/O error as absence
    // would have telstore overwrite the user's file without asking.
    let exists = true
    try {
      await fs.stat(target)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      exists = false
    }

    if (exists && !(await confirm(`${target} already exists. Overwrite? [y/N] `))) {
      throw new Error('Cancelled on request.')
    }

    log(`Backup ${manifest.id}`)
    log(`File   ${target} (${formatBytes(manifest.size)}, ${manifest.chunks.length} chunks)\n`)

    const handle = await fs.open(partial, 'w+')

    try {
      await handle.truncate(manifest.size)

      // One bar for the whole restore. The label names the chunk in flight, but the bar, the
      // byte counts, the speed and the ETA all describe the file, so the line runs 0% to 100%
      // once instead of restarting at every chunk boundary — with 1800MB chunks, a per-chunk
      // ETA answers a question nobody asked.
      // warn is already the no-op when silent, and createProgress draws through nothing else.
      const progress = createProgress({
        total: manifest.size,
        label: `Chunk 1/${manifest.chunks.length}`,
        write: warn,
      })

      try {
        for (const chunk of manifest.chunks) {
          // Before getMessage, not after: the bar is then on screen from the first moment,
          // and finish() below always has a line to close.
          progress.setLabel(`Chunk ${chunk.i + 1}/${manifest.chunks.length}`)

          const message = await getMessage(client, chat, chunk.msgId)

          if (!message) {
            throw new Error(
              `Missing chunk ${chunk.i + 1}/${manifest.chunks.length}: message ${chunk.msgId} is no longer in ${chat}. ` +
                'This backup cannot be restored.',
            )
          }

          const { sha256, size } = await downloadChunk(
            client,
            message,
            handle,
            chunk.i * manifest.chunkSize,
            progress.advance,
            {
              retryOptions: { ...retryOptions, onRetry },
              concurrency: settings.downloadConcurrency,
            },
          )

          if (size !== chunk.size) {
            throw new Error(
              `Chunk ${chunk.i + 1} has ${size} bytes, the manifest records ${chunk.size} bytes — mismatch.`,
            )
          }

          if (sha256 !== chunk.sha256) {
            throw new Error(
              `Chunk ${chunk.i + 1} has a sha256 that does not match the manifest. The download is kept at ${partial} for inspection.`,
            )
          }
        }
      } finally {
        // The bar owns a line that \r keeps returning to. Ending it here rather than after the
        // loop means a chunk that fails mid-download still leaves the cursor on a fresh line,
        // so "Error: ..." does not land on top of the bar.
        progress.finish()
      }
    } finally {
      await handle.close()
    }

    // Last line of defence: if every chunk matched its sha256 and the file is still the
    // wrong length, the layout went wrong somewhere. Better to fail than to rename a
    // wrong file into the real one.
    const written = await fs.stat(partial)

    if (written.size !== manifest.size) {
      throw new Error(
        `The assembled file has ${written.size} bytes, the manifest records ${manifest.size} bytes — mismatch. ` +
          `The download is kept at ${partial} for inspection.`,
      )
    }

    await fs.rename(partial, target)

    log(`\nDone. Wrote ${formatBytes(manifest.size)} to ${target}`)

    return { path: target, size: manifest.size }
  } finally {
    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}


// `telstore restore a b c` is three restores, not one download: each backup keeps its own
// manifest, its own name and its own verification, so a batch is what running the command
// three times would have produced minus two logins. As with uploads, the connection is shared
// through the deps seam, which leaves runRestore the only caller of connect.
export async function runRestores(backupIds, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
  } = deps

  // One id must read exactly as it did before this existed: --out still works, the error still
  // reaches the caller, and nothing prints a summary of a list with one thing in it.
  if (backupIds.length === 1) {
    const { path: target, size } = await runRestore(backupIds[0], options, deps)
    return { results: [{ id: backupIds[0], path: target, size }], failed: 0 }
  }

  // Everything knowable before the first byte arrives is settled here, so a batch never stops
  // halfway over something that was already visible on the command line.
  if (options.out !== undefined) {
    throw new Error(
      `--out names one file, and this run restores ${backupIds.length} backups. Leave it off ` +
        'to write each one under the name in its own manifest, or restore them one command at ' +
        'a time to choose the names yourself.',
    )
  }

  const duplicate = backupIds.find((id, index) => backupIds.indexOf(id) !== index)

  if (duplicate) {
    throw new Error(
      `${duplicate} is named twice. Restoring one backup twice would write the same file ` +
        'over itself — name it once.',
    )
  }

  const config = await loadConfig(configDir)

  // Once for the batch. Reported from inside the loop, "Not logged in" would arrive once per
  // id, each time as though that particular backup were the problem.
  assertLoggedIn(config)

  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  requireChat(settings)

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  let shared = null
  const perId = {
    ...deps,
    connect: async (theirConfig, connectOptions) =>
      (shared ??= await connect(theirConfig, connectOptions)),
    disconnect: async () => {},
  }

  const results = []

  try {
    for (const [index, backupId] of backupIds.entries()) {
      if (index > 0) log('')
      log(`[${index + 1}/${backupIds.length}] ${backupId}`)

      try {
        const { path: target, size } = await runRestore(backupId, options, perId)
        results.push({ id: backupId, path: target, size })
      } catch (err) {
        // A backup whose chunks are gone says nothing about the next one, and the summary at
        // the end would arrive an hour after the bar of the following id started scrolling
        // over it — so it is named here, and again down there, and carried out as exit code 1.
        results.push({ id: backupId, error: err.message })
        warn(`\n${backupId} failed: ${err.message}\n`)
      }
    }
  } finally {
    if (shared) {
      await closeQuietly(shared, disconnect, (err) =>
        warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
      )
    }
  }

  const failed = results.filter((result) => result.error).length

  log('')
  for (const line of summaryLines(results, failed)) log(line)

  return { results, failed }
}

// Every id gets a line whether it worked or not: one missing from this list would be a backup
// nobody could tell the fate of.
function summaryLines(results, failed) {
  const width = Math.max(...results.map((result) => result.id.length))
  const restored = results.length - failed

  const lines = [
    `${results.length} backups: ${restored} restored, ${failed} failed.`,
    '',
    ...results.map((result) => {
      const id = result.id.padEnd(width)

      return result.error
        ? `  ${id}  failed: ${result.error}`
        : `  ${id}  ${result.path} (${formatBytes(result.size)})`
    }),
  ]

  return lines
}
