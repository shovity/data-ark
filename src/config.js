import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILE_NAME = 'config.json'

export function defaultConfigDir() {
  return path.join(os.homedir(), '.telstore')
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
// return undefined, and telstore would then run happily on built-in defaults while the
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
        'not a group of settings. telstore will not guess what was meant — fix that entry, ' +
        'or remove it to fall back to the defaults.',
    )
  }

  // What `login --token` leaves behind: the session and the api_hash sealed inside one blob
  // that only a passphrase opens. It is read by `connect`, never by anything that writes.
  if (raw.sealed !== undefined && typeof raw.sealed !== 'string') {
    throw new Error(
      `"sealed" in ${file} holds ${Array.isArray(raw.sealed) ? 'a list' : typeof raw.sealed}, ` +
        'not a sealed session. Log in again with "npx telstore login --token", or remove that ' +
        'entry and log in with a phone number.',
    )
  }

  // Two sources of truth for one account, and nothing to say which one was meant. Guessing
  // would mean connecting as an account the user did not choose — either the stale one they
  // thought they had replaced, or the one they thought they had left behind.
  if (raw.sealed !== undefined && (raw.session !== undefined || raw.apiHash !== undefined)) {
    throw new Error(
      `${file} holds both a sealed session and a plain one. telstore will not guess which ` +
        'account was meant — delete the file and log in again.',
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
        'Fix the syntax to keep your session, or delete the file and run "telstore login" again.',
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

// Both shapes go, because they are the same thing written two ways. On a machine that logged
// in with a token the api_hash lives inside the sealed blob, so keeping it "like an ordinary
// logout does" would keep the entire account.
export async function clearSession(dir = defaultConfigDir()) {
  const config = await loadConfig(dir)
  delete config.session
  delete config.sealed
  await saveConfig(config, dir)
}
