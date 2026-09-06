import path from 'node:path'

import { countChunks } from '../chunking.js'
import { describeChat } from '../chat.js'
import { assertLoggedIn, closeQuietly, connect as realConnect } from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { formatBytes } from '../progress.js'
import { resolveSettings } from '../settings.js'
import { listStates } from '../state.js'

const LABEL_WIDTH = 'Destination'.length + 2

function row(label, value) {
  return `${label.padEnd(LABEL_WIDTH)}${value}`
}

function describeAccount(me) {
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ')
  const handle = me.username ? ` (@${me.username})` : ''

  return `${name || me.username || me.phone || 'unknown'}${handle}`
}

// The account line is the only part that needs Telegram, and it is also the only part that
// can fail. Whatever it costs, it must not take the rest of the report down with it: the
// unfinished backups are exactly what someone runs status to see after a session expires.
async function accountLine(config, verbose, deps) {
  const { connect, disconnect } = deps

  try {
    assertLoggedIn(config)
  } catch (err) {
    return err.message
  }

  let client
  try {
    client = await connect(config, { verbose })
  } catch (err) {
    return err.message
  }

  try {
    return describeAccount(await client.getMe())
  } catch (err) {
    return `could not be read: ${err.message}`
  } finally {
    await closeQuietly(client, disconnect)
  }
}

export async function runStatus(options = {}, deps = {}) {
  const {
    configDir = defaultConfigDir(),
    connect = realConnect,
    disconnect = (client) => client.destroy(),
    log = (line) => console.log(line),
  } = deps

  const config = await loadConfig(configDir)

  // status is what someone runs *because* something is wrong, so nothing here may take the
  // whole report down — the same reason accountLine catches its own failures. A stored
  // setting that will not parse is loud everywhere else; here it is loud in the row it
  // belongs to, with the account and the unfinished backups still printed around it.
  let settings = null
  let settingsError = null

  try {
    settings = resolveSettings(options, config, { file: configFile(configDir) }).values
  } catch (err) {
    settingsError = err.message
  }

  log(row('Account', await accountLine(config, settings?.verbose ?? false, { connect, disconnect })))
  log(
    row(
      'Destination',
      settingsError ??
        (settings.chat === null
          ? 'none set — run "npx data-ark config chat @my_backups" to set one'
          : describeChat(settings.chat)),
    ),
  )

  const states = await listStates(configDir)

  if (states.length === 0) {
    log(row('Unfinished', 'none'))
    return
  }

  log(row('Unfinished', `${states.length} backup${states.length === 1 ? '' : 's'}`))

  for (const state of states) {
    const total = countChunks(state.size, state.chunkSize)
    const done = Object.keys(state.done ?? {}).length

    log(`  ${state.id}  ${path.basename(state.path)}  ${done}/${total} chunks  ${formatBytes(state.size)}`)
    log(`  → ${describeChat(state.chat)}`)
  }
}
