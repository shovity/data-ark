import { chatName, describeChat } from '../chat.js'
import {
  DELETE_BATCH_SIZE,
  assertLoggedIn,
  closeQuietly,
  connect as realConnect,
  deleteMessages as realDeleteMessages,
  findManifestMessage,
  readMessageBytes as realReadMessageBytes,
} from '../client.js'
import { askConfirm } from '../confirm.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { manifestFileName, manifestMessageIds, parseManifestJson } from '../manifest.js'
import { formatBytes, formatDuration } from '../progress.js'
import { requireChat, resolveSettings } from '../settings.js'
import { clearState, findStates } from '../state.js'

// What list prints when a card cannot be read back. A manifest is text off a chat, and a
// summary is not worth inventing: the numbers below only decorate a decision the backup id
// has already settled.
const UNKNOWN = '—'

function describeName(name) {
  return typeof name === 'string' && name.trim() !== '' ? name : UNKNOWN
}

function describeSize(size) {
  return Number.isSafeInteger(size) && size >= 0 ? formatBytes(size) : UNKNOWN
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// The same rule the manifest gets, for the same reason: a message id is the name of
// something about to be destroyed for good, so a record that cannot say it exactly is
// refused whole rather than half-obeyed. Sorted by chunk index so the batches — and the
// error naming a chunk — are the same on every run.
function stateMessageIds(record) {
  const done = record.state.done

  if (typeof done !== 'object' || done === null) {
    throw new Error(
      `The record of unfinished backup ${record.state.id} does not list the chunks it sent. ` +
        `${record.file} is damaged — delete that file by hand to drop the record, which ` +
        'leaves any chunks it did send sitting in the chat with nothing to point at them.',
    )
  }

  return Object.entries(done)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([index, entry]) => {
      const msgId = entry?.msgId

      if (!Number.isSafeInteger(msgId) || msgId < 1) {
        throw new Error(
          `The record of unfinished backup ${record.state.id} gives ` +
            `${JSON.stringify(msgId)} as the message id of chunk ${Number(index) + 1}, which ` +
            `is not a message id. ${record.file} is damaged, so data-ark is not deleting ` +
            'anything.',
        )
      }

      return msgId
    })
}

export async function runDelete(backupId, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    searchManifest = findManifestMessage,
    readMessageBytes = realReadMessageBytes,
    deleteMessages = realDeleteMessages,
    confirm = askConfirm,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    log: writeLog = (line) => console.log(line),
    silent = false,
  } = deps

  const config = await loadConfig(configDir)
  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  // Before requireChat, as in list: telling somebody who has never logged in to go and pick
  // a destination sends them after the wrong thing.
  assertLoggedIn(config)
  const chat = requireChat(settings)

  const log = silent ? () => {} : writeLog
  const warn = silent ? () => {} : writeErr

  // Upload and restore stay quiet until the third retry so a handful of -503s do not bury
  // the progress bar. There is no bar here to bury, and a wait in the middle of destroying
  // somebody's backup is always worth saying out loud — so this one announces from the first.
  function onRetry(err, attempt, delayMs) {
    warn(
      `\nTemporary error (${err.message}), retry ${attempt} in ` +
        `${formatDuration(delayMs / 1000)}.\n`,
    )
  }

  // A local lookup that refuses should not cost a connection first.
  const records = await findStates(backupId, configDir)

  if (records.length > 1) {
    throw new Error(
      `Two local records both claim to be backup ${backupId}: ` +
        `${records.map((r) => r.file).join(' and ')}. data-ark will not guess which one to ` +
        'drop — remove the wrong one by hand and run again.',
    )
  }

  const record = records[0] ?? null
  const client = await connect(config, { verbose: settings.verbose })

  try {
    const manifestMessage = await searchManifest(client, chat, backupId)

    if (!manifestMessage && !record) {
      throw new Error(
        `No backup ${backupId} found in ${chatName(chat)}, and no unfinished record of it on ` +
          'this machine. Check the id with "npx data-ark list", or use --to to point at the ' +
          'right chat.',
      )
    }

    let manifest = null
    const ids = new Set()

    if (manifestMessage) {
      manifest = parseManifestJson(await readMessageBytes(client, manifestMessage))

      // The manifest was found by the file name data-ark itself wrote, and that name is the
      // id this command was asked about. A body naming a different backup is a file that was
      // renamed or replaced, and its message ids point at somebody else's chunks — the one
      // mistake in this whole command that nothing can undo.
      if (manifest?.id !== undefined && manifest.id !== backupId) {
        throw new Error(
          `The manifest named ${manifestFileName(backupId)} describes backup ` +
            `${JSON.stringify(manifest.id)}, not ${backupId}. Its message ids point at ` +
            'another backup\'s chunks, so data-ark is not deleting anything.',
        )
      }

      for (const id of manifestMessageIds(manifest)) ids.add(id)
    }

    // Both sources describe the same backup, so an id in either is a message this backup put
    // in the chat. In practice the record holds nothing the manifest does not — but it is a
    // file on disk that a truncated write or a hand edit can mangle, and an id left out here
    // is a chunk that nothing can point at ever again.
    if (record) {
      for (const id of stateMessageIds(record)) ids.add(id)
    }

    const chunkIds = [...ids]

    if (manifest) {
      log(`Backup ${backupId}`)
      log(
        `File   ${describeName(manifest.name)} ` +
          `(${describeSize(manifest.size)}, ${plural(manifest.chunks.length, 'chunk')})`,
      )
    } else {
      log(`Backup ${backupId} (unfinished — no manifest in the chat)`)
      log(`File   ${describeName(record.state.path)}`)
    }

    log(`From   ${describeChat(chat)}`)
    log('')

    const prompt = manifest
      ? `Delete this backup from ${chatName(chat)}? The chunks cannot be recovered. [y/N] `
      : `Delete the ${plural(chunkIds.length, 'chunk message')} it sent, and its local ` +
        `record? The chunks cannot be recovered. [y/N] `

    if (!options.yes && !(await confirm(prompt))) {
      throw new Error('Cancelled on request.')
    }

    const loud = chunkIds.length > DELETE_BATCH_SIZE
    let removed = 0

    try {
      await deleteMessages(client, chat, chunkIds, {
        retryOptions: { ...retryOptions, onRetry },
        onBatch: (done, total) => {
          removed = done
          if (loud) warn(`\rRemoving chunk messages ${done}/${total}…`)
        },
      })
    } catch (err) {
      throw new Error(
        `Removed ${removed} of ${plural(chunkIds.length, 'chunk message')} of ${backupId}, ` +
          `then Telegram refused: ${err.message}. ` +
          (manifestMessage
            ? 'The manifest was left in place on purpose — it is the only list of the ' +
              'messages that are still there. '
            : 'The local record was left in place on purpose — it is the only list of the ' +
              'messages that are still there. ') +
          'Run the same command again to finish.',
      )
    }

    if (loud) warn('\n')

    // Only now. The manifest is the only index of the ids above, and where there is no
    // manifest the local record is. Anything that throws before this line leaves the way
    // back intact, and running delete again picks up where this run stopped.
    if (manifestMessage) {
      try {
        await deleteMessages(client, chat, [manifestMessage.id], {
          retryOptions: { ...retryOptions, onRetry },
        })
      } catch (err) {
        throw new Error(
          `Removed every chunk message of ${backupId}, but Telegram refused to remove its ` +
            `manifest: ${err.message}. Run the same command again to finish.`,
        )
      }
    }

    if (record) await clearState(record.key, configDir)

    if (manifestMessage) {
      log(
        `\nDone. Removed ${backupId} from ${chatName(chat)}: ` +
          `${plural(chunkIds.length, 'chunk message')} and its manifest.`,
      )
      if (record) log('The local record of this backup was removed too.')
    } else {
      log(
        `\nDone. Removed ${plural(chunkIds.length, 'chunk message')} from ${chatName(chat)} ` +
          `and dropped the local record of ${backupId}.`,
      )
    }

    return {
      id: backupId,
      chunks: chunkIds.length,
      manifestDeleted: Boolean(manifestMessage),
      stateCleared: Boolean(record),
    }
  } finally {
    await closeQuietly(client, disconnect, (err) =>
      warn(`\nWarning: could not close the Telegram connection: ${err.message}\n`),
    )
  }
}
