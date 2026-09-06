import { formatBytes } from './progress.js'

// Captions are plain text on purpose. Telegram would render bold through a parse mode,
// but that turns every file name into something that has to be escaped correctly, and
// the fake client the tests talk to would never notice a mistake there.

const DIVIDER = '━'.repeat(15)

// The hashtag is what `list` searches for, and it lives on the manifest alone: chunk
// captions stay out of that search so a twelve-chunk backup is one hit, not thirteen.
export const MANIFEST_TAG = '#telstore'

// A file name may legally contain a newline or a tab, and either one would push the
// rest of the card down a row and take its shape apart.
function oneLine(name) {
  return String(name).replace(/\s+/g, ' ').trim()
}

function utcMinutes(createdAt) {
  return `${new Date(createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function chunkCaption({ id, number, total }) {
  return `📦 ${id} · ${number}/${total}`
}

export function manifestCaption({ id, name, size, chunks, createdAt }) {
  return [
    `🗄 ${oneLine(name)}`,
    DIVIDER,
    `💾 ${formatBytes(size)} · ${chunks} chunk${chunks === 1 ? '' : 's'}`,
    `🆔 ${id}`,
    `📅 ${utcMinutes(createdAt)}`,
    '',
    `↩ npx telstore restore ${id}`,
    MANIFEST_TAG,
  ].join('\n')
}

function marker(lines, emoji) {
  const found = lines.find((line) => line.startsWith(`${emoji} `))
  return found ? found.slice(emoji.length + 1).trim() : null
}

// list reads what the chat shows, and a caption is text a person can edit. Anything that
// does not carry the whole card is reported as unknown rather than half-guessed: a backup
// listed with invented numbers is worse than one listed with dashes.
export function parseManifestCaption(text) {
  const lines = String(text ?? '').split('\n')

  const name = marker(lines, '🗄')
  const totals = marker(lines, '💾')
  const id = marker(lines, '🆔')
  const createdAt = marker(lines, '📅')

  if (!name || !totals || !id || !createdAt) return null

  const match = /^(.+) · (\d+) chunks?$/.exec(totals)

  if (!match) return null

  return { id, name, size: match[1], chunks: Number(match[2]), createdAt }
}
