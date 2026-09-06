import { MANIFEST_TAG, parseManifestCaption } from '../caption.js'
import { chatName, describeChat } from '../chat.js'
import {
  closeQuietly,
  connect as realConnect,
  searchDocuments,
} from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { assertLoggedIn } from '../session.js'
import { requireChat, resolveSettings } from '../settings.js'

const UNKNOWN = '—'
const GAP = '  '

const COLUMNS = [
  { header: 'BACKUP ID', key: 'id' },
  { header: 'FILE', key: 'name' },
  { header: 'SIZE', key: 'size', right: true },
  { header: 'CHUNKS', key: 'chunks', right: true },
  { header: 'CREATED', key: 'created' },
  { header: 'NOTE', key: 'note' },
]

// The table is read at a glance, and the note is the one field with no shape at all — 500
// characters of it would push every column off the side. The whole note is still in the
// manifest and on the card in the chat, which is where anyone reading it properly will look.
const NOTE_WIDTH = 40

function shorten(note) {
  return note.length > NOTE_WIDTH ? `${note.slice(0, NOTE_WIDTH - 1)}…` : note
}

// Telegram indexes the tag the manifest caption carries, so one search returns one hit
// per backup instead of one per chunk. What comes back is still whatever the server
// decided to match, which is why the caller filters on the file name afterwards.
async function realSearchManifests(client, peer, limit) {
  return await searchDocuments(client, peer, { search: MANIFEST_TAG, limit })
}

function backupIdFromFileName(fileName) {
  return fileName.replace(/\.manifest\.json$/, '')
}

function utcDay(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

// The card is text in a chat, which means a person can edit or predate it. The id is the
// one field restore cannot be wrong about, so it always comes from the file name telstore
// wrote; the caption only decorates. A card that cannot be read back leaves the rest
// unknown, because inventing it would describe a backup that does not exist.
function toRow(message) {
  const id = backupIdFromFileName(message.fileName)
  const card = parseManifestCaption(message.caption)

  if (!card) {
    return {
      id,
      name: UNKNOWN,
      size: UNKNOWN,
      chunks: UNKNOWN,
      created: utcDay(message.date),
      note: UNKNOWN,
    }
  }

  return {
    id,
    name: card.name,
    size: card.size,
    chunks: String(card.chunks),
    created: card.createdAt.slice(0, 10),
    note: card.note ? shorten(card.note) : UNKNOWN,
  }
}

function renderTable(rows) {
  // Most people never write a note, and a column of dashes tells them nothing they did not
  // already know while costing every other column the width it takes.
  const columns = COLUMNS.filter(
    (column) => column.key !== 'note' || rows.some((row) => row.note !== UNKNOWN),
  )

  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => row[column.key].length)),
  )

  const line = (cells) =>
    cells
      .map((cell, i) => (columns[i].right ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
      .join(GAP)
      .trimEnd()

  return [
    line(columns.map((column) => column.header)),
    ...rows.map((row) => line(columns.map((column) => row[column.key]))),
  ]
}

export async function runList(options = {}, deps = {}) {
  const {
    configDir = defaultConfigDir(),
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    searchManifests = realSearchManifests,
    log = (line) => console.log(line),
  } = deps

  const config = await loadConfig(configDir)
  const { values: settings } = resolveSettings(options, config, { file: configFile(configDir) })
  // Ask about the login before the destination: telling someone who has never logged in
  // to pick a chat sends them off after the wrong thing.
  assertLoggedIn(config)
  const chat = requireChat(settings)

  const client = await connect(config, { verbose: settings.verbose })

  let found
  try {
    found = await searchManifests(client, chat, settings.limit)
  } finally {
    await closeQuietly(client, disconnect)
  }

  log(`Destination  ${describeChat(chat)}`)
  log('')

  const rows = found
    .filter((message) => message.fileName?.endsWith('.manifest.json'))
    .map(toRow)

  if (rows.length === 0) {
    log(`No backups found in ${chatName(chat)}. Upload one with: npx telstore <file>`)
    return rows
  }

  for (const line of renderTable(rows)) log(line)

  log('')
  log(`${rows.length} backup${rows.length === 1 ? '' : 's'}. Restore with: npx telstore restore <backup-id>`)

  return rows
}
