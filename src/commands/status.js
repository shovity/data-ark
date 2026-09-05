import path from 'node:path'

import { countChunks } from '../chunking.js'
import { assertLoggedIn, closeQuietly, connect as realConnect, describeChat } from '../client.js'
import { defaultConfigDir, loadConfig } from '../config.js'
import { runSetDestination } from './set-destination.js'
import { formatBytes } from '../progress.js'
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
async function accountLine(config, options, deps) {
  const { connect, disconnect } = deps

  try {
    assertLoggedIn(config)
  } catch (err) {
    return err.message
  }

  let client
  try {
    client = await connect(config, { verbose: options.verbose })
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

  // `status --to @chan` reads as one request: point somewhere new, then show me where I am.
  // Setting it first is also what makes the Destination line below tell the current truth.
  if (options.to) {
    await runSetDestination(options, { configDir, log: () => {} })
  }

  const config = await loadConfig(configDir)

  log(row('Account', await accountLine(config, options, { connect, disconnect })))
  log(
    row(
      'Destination',
      config.defaultChat
        ? describeChat(config.defaultChat)
        : 'none set — pass --to @my_backups to set one',
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
