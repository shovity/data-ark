import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { defaultConfigDir, writeJsonAtomic } from './config.js'

export function stateDir(configDir = defaultConfigDir()) {
  return path.join(configDir, 'state')
}

export function stateKey(absPath, size, mtimeMs) {
  return createHash('sha1').update(`${absPath}:${size}:${mtimeMs}`).digest('hex')
}

export function stateFile(key, configDir = defaultConfigDir()) {
  return path.join(stateDir(configDir), `${key}.json`)
}

export async function loadState(key, configDir = defaultConfigDir()) {
  try {
    return JSON.parse(await fs.readFile(stateFile(key, configDir), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof SyntaxError) return null
    throw err
  }
}

export async function saveState(key, state, configDir = defaultConfigDir()) {
  await writeJsonAtomic(stateFile(key, configDir), state)
}

export async function markChunkDone(key, state, i, entry, configDir = defaultConfigDir()) {
  const updated = { ...state, done: { ...state.done, [String(i)]: entry } }
  await saveState(key, updated, configDir)
  return updated
}

export async function clearState(key, configDir = defaultConfigDir()) {
  try {
    await fs.unlink(stateFile(key, configDir))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

// A state file is only useful while its backup can still be resumed, and nothing ever
// removes one whose file was edited since: the key includes mtime, so that state can never
// match again. Left alone the directory only grows, and with it the report `status` prints.
export const MAX_STATES = 20

// The newest states are the ones worth keeping, and a state file is rewritten every time a
// chunk lands, so its mtime is when this backup last made progress. Returns the states that
// were dropped: the caller says their ids out loud, because after this the id is the only
// way left to find those chunks in the chat.
export async function pruneStates(configDir = defaultConfigDir(), keep = MAX_STATES) {
  let names
  try {
    names = await fs.readdir(stateDir(configDir))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  const files = []

  for (const name of names) {
    if (!name.endsWith('.json')) continue

    const file = path.join(stateDir(configDir), name)

    try {
      const stat = await fs.stat(file)
      files.push({ key: name.slice(0, -'.json'.length), file, mtimeMs: stat.mtimeMs })
    } catch (err) {
      // Gone between readdir and stat: nothing left to prune.
      if (err.code !== 'ENOENT') throw err
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const dropped = []

  for (const { key, file } of files.slice(keep)) {
    // Read before unlink: a file that cannot be read back, or that carries no id, is
    // still pruned — it just cannot be named, and a report naming nothing helps no one.
    const state = await loadState(key, configDir)
    await fs.unlink(file)
    if (state?.id) dropped.push(state)
  }

  return dropped
}

// status needs every unfinished backup at once. A state file that cannot be read is skipped
// rather than fatal, for the same reason loadState returns null: one corrupt file must not
// hide the other backups still waiting to be finished.
//
// The key comes back alongside each record because canResume needs it, and the file name is
// the only place it survives: the record's own path, size and mtime are exactly what a
// rewritten file makes stale, so recomputing the key from them would always say yes.
export async function listStates(configDir = defaultConfigDir()) {
  let names
  try {
    names = await fs.readdir(stateDir(configDir))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  const states = []

  for (const name of names) {
    if (!name.endsWith('.json')) continue

    const key = name.slice(0, -'.json'.length)
    const state = await loadState(key, configDir)

    if (state) states.push({ key, state })
  }

  return states
}

// delete needs the file a record came from, not just its contents — and the name of that
// file is a hash of the path, size and mtime *inside* the record, so recomputing it would
// be trusting an untrusted file to say where it lives. A hand-edited path yields a key that
// names no file at all, clearState ignores a file that is not there, and telstore reports a
// record dropped that is still sitting on disk. Matching the id inside each file is the one
// way that cannot point at the wrong one.
//
// Every record claiming the id is returned rather than the first: two of them means telstore
// cannot know which to drop, and that is the caller's decision to refuse, not ours to make
// by picking one.
export async function findStates(backupId, configDir = defaultConfigDir()) {
  let names
  try {
    names = await fs.readdir(stateDir(configDir))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  const found = []

  for (const name of names) {
    if (!name.endsWith('.json')) continue

    const key = name.slice(0, -'.json'.length)
    const state = await loadState(key, configDir)

    if (state?.id === backupId) found.push({ key, file: stateFile(key, configDir), state })
  }

  return found
}

// Whether a record can still be resumed, which is not a question about the record alone:
// runUpload hashes the file it finds on disk and looks the result up, so a backup is
// resumable exactly when that hash is still the key this record is filed under. Recomputing
// through stateKey rather than comparing size and mtime by hand is the point — a second way
// of asking is a second way to drift, and status would end up promising a resume that upload
// turns into a brand new backup, stranding every chunk already sent.
//
// Never throws. status calls this for every record it prints, and one damaged path must not
// take the rest of the report down with it.
export async function canResume(key, state) {
  let stat

  try {
    stat = await fs.stat(state.path)
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unreadable' }
  }

  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }
  if (stateKey(state.path, stat.size, stat.mtimeMs) !== key) return { ok: false, reason: 'changed' }

  return { ok: true }
}
