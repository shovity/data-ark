import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILE_NAME = 'config.json'

export function defaultConfigDir() {
  return path.join(os.homedir(), '.data-ark')
}

export async function loadConfig(dir = defaultConfigDir()) {
  const file = path.join(dir, FILE_NAME)

  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }

  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Corrupt config file: ${file}. Delete it and run "data-ark login" again.`)
  }
}

// Config and state are both small JSON files holding something that must survive a crash
// mid-write: write beside the target, then rename, which is atomic on the same filesystem.
export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })

  const tmp = `${file}.tmp`

  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, file)
}

export async function saveConfig(config, dir = defaultConfigDir()) {
  await writeJsonAtomic(path.join(dir, FILE_NAME), config)
}

export async function clearSession(dir = defaultConfigDir()) {
  const config = await loadConfig(dir)
  delete config.session
  await saveConfig(config, dir)
}
