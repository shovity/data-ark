import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILE_NAME = 'config.json'

export function defaultConfigDir() {
  return path.join(os.homedir(), '.data-ark')
}

export function configFile(dir = defaultConfigDir()) {
  return path.join(dir, FILE_NAME)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// `config.json` is hand-editable now that the `config` command invites people into it,
// which puts it in the same category as a manifest or a state file: believed only after it
// has been checked. A `settings` that is not an object would make every lookup below it
// return undefined, and data-ark would then run happily on built-in defaults while the
// user's own choices sat there ignored — so it is named and refused instead.
export function checkConfigShape(raw, file) {
  if (!isPlainObject(raw)) {
    throw new Error(
      `Corrupt config file: ${file} holds ${Array.isArray(raw) ? 'a list' : typeof raw}, ` +
        'not a group of settings.',
    )
  }

  if (raw.settings !== undefined && !isPlainObject(raw.settings)) {
    throw new Error(
      `"settings" in ${file} holds ${Array.isArray(raw.settings) ? 'a list' : typeof raw.settings}, ` +
        'not a group of settings. data-ark will not guess what was meant — fix that entry, ' +
        'or remove it to fall back to the defaults.',
    )
  }

  return raw
}

export async function loadConfig(dir = defaultConfigDir()) {
  const file = configFile(dir)

  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Corrupt config file: ${file} is not valid JSON (${err.message}). ` +
        'Fix the syntax to keep your session, or delete the file and run "data-ark login" again.',
    )
  }

  return checkConfigShape(parsed, file)
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
  await writeJsonAtomic(configFile(dir), config)
}

export async function clearSession(dir = defaultConfigDir()) {
  const config = await loadConfig(dir)
  delete config.session
  await saveConfig(config, dir)
}
