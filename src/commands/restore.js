import { promises as fs } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { closeQuietly, connect as realConnect, requireChat, searchDocuments } from '../client.js'
import { defaultConfigDir, loadConfig } from '../config.js'
import { downloadToFile } from '../downloader.js'
import { manifestFileName, parseManifest } from '../manifest.js'
import { createProgress, formatBytes, formatDuration } from '../progress.js'

// Anything past a minute of waiting needs saying out loud; below that the pause is shorter
// than the time a user would spend wondering about it.
const LONG_WAIT_MS = 60_000

async function realSearchManifest(client, peer, backupId) {
  const wanted = manifestFileName(backupId)
  const found = await searchDocuments(client, peer, { search: backupId, limit: 100 })

  return found.find((doc) => doc.fileName === wanted)?.message ?? null
}

async function realReadMessageBytes(client, message) {
  return await client.downloadMedia(message)
}

async function realGetMessage(client, peer, msgId) {
  const [message] = await client.getMessages(peer, { ids: [msgId] })
  return message ?? null
}

export async function realDownloadChunk(client, message, handle, offset, onProgress, retryOptions) {
  return await downloadToFile(client, message, handle.fd, { offset, onProgress, retryOptions })
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

async function askConfirm(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  const answer = await rl.question(question)
  rl.close()
  return /^y/i.test(answer.trim())
}

export async function runRestore(backupId, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = realSearchManifest,
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
  const chat = requireChat(options, config)
  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  // A restore keeps no progress file, so a part that comes back -503 is retried rather than
  // thrown away — and a retry nobody is told about is indistinguishable from a hung transfer,
  // because the progress bar simply stops moving while the wait runs.
  function onRetry(err, attempt, delayMs) {
    if (delayMs > LONG_WAIT_MS) {
      warn(
        `\nTelegram wants ${formatDuration(delayMs / 1000)} of waiting before the next part ` +
          `(${err.message}). data-ark is waiting and will carry on by itself, leave it running.\n`,
      )
      return
    }

    warn(
      `\nTemporary error (${err.message}), retry ${attempt} in ` +
        `${formatDuration(delayMs / 1000)}.\n`,
    )
  }

  const client = await connect(config, { verbose: options.verbose })

  try {
    const manifestMessage = await searchManifest(client, chat, backupId)

    if (!manifestMessage) {
      throw new Error(
        `No manifest found for ${backupId} in ${chat}. ` +
          'Check the backup id, or use --to to point at the right chat.',
      )
    }

    const manifest = parseManifest(await readMessageBytes(client, manifestMessage))
    // When the user passes --out, respect that path verbatim.
    const target = path.resolve(options.out ?? safeOutName(manifest.name))
    const partial = `${target}.partial`

    // Only ENOENT means "no file yet". Treating a permission or I/O error as absence
    // would have data-ark overwrite the user's file without asking.
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
            { ...retryOptions, onRetry },
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
