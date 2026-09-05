import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { defaultConfigDir } from './config.js'

export function stateDir(configDir = defaultConfigDir()) {
  return path.join(configDir, 'state')
}

export function stateKey(absPath, size, mtimeMs) {
  return createHash('sha1').update(`${absPath}:${size}:${mtimeMs}`).digest('hex')
}

function stateFile(key, configDir) {
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
  const dir = stateDir(configDir)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })

  const file = stateFile(key, configDir)
  const tmp = `${file}.tmp`

  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, file)
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

// status needs every unfinished backup at once. A state file that cannot be read is skipped
// rather than fatal, for the same reason loadState returns null: one corrupt file must not
// hide the other backups still waiting to be finished.
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

    const state = await loadState(name.slice(0, -'.json'.length), configDir)
    if (state) states.push(state)
  }

  return states
}
