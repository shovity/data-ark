import { countChunks } from '../chunking.js'
import { describeChat } from '../chat.js'
import { closeQuietly, connect as realConnect } from '../client.js'
import { configFile, defaultConfigDir, loadConfig } from '../config.js'
import { formatBytes } from '../progress.js'
import { assertLoggedIn } from '../session.js'
import { resolveSettings } from '../settings.js'
import { canResume, listStates } from '../state.js'

const LABEL_WIDTH = 'Destination'.length + 2

function row(label, value) {
  return `${label.padEnd(LABEL_WIDTH)}${value}`
}

// Each unfinished backup gets its own indented block, so the fields line up under a heading
// that is the id — the one string `restore` and `delete` both take.
const FIELD_WIDTH = 'Resume'.length + 3
const CONTINUATION = ' '.repeat(FIELD_WIDTH + 2)

function field(label, value) {
  return `  ${label.padEnd(FIELD_WIDTH)}${value}`
}

// The Resume line is a command meant to be pasted, so anything a shell would take apart has
// to come back quoted — a path with a space in it is the ordinary case, not an exotic one.
const BARE_ARG = /^[A-Za-z0-9_@%+:,./-]+$/

function shellArg(text) {
  const value = String(text)

  return BARE_ARG.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

// runUpload refuses to send the rest of a backup to a different chat, so the command has to
// name the one the chunks are already in — unless the destination in force is that chat
// anyway, where --chat would just be noise. Not knowing the destination counts as not matching:
// leaving --chat out would be a guess about where a backup already in progress went.
function resumeCommand(state, destination) {
  const matches = destination !== null && state.chat === String(destination)

  return `npx telstore ${shellArg(state.path)}${matches ? '' : ` --chat ${shellArg(state.chat)}`}`
}

// Why a resume is off the table, in the words of the thing the user would have to fix. The
// record is keyed on the file's path, size and mtime, so any of these means runUpload would
// hash the file to a different key, find nothing, and start a second backup instead.
const NO_RESUME = {
  missing: 'the file is no longer there',
  changed: 'the file has changed since the backup started',
  'not-a-file': 'that path is no longer a file',
  unreadable: 'the record does not name a file that can be read',
}

// A command is printed only when it will really resume. Printing one regardless would be
// telling the user to run something that quietly starts a second backup and abandons every
// chunk this one already sent — and those chunks are then findable only by this id, which
// is worth saying while there are any.
async function resumeLines(key, state, destination, done) {
  const check = await canResume(key, state)

  if (check.ok) return [field('Resume', resumeCommand(state, destination))]

  const lines = [field('Resume', `not possible: ${NO_RESUME[check.reason]}.`)]

  if (done > 0) {
    lines.push(
      `${CONTINUATION}${done} chunk${done === 1 ? ' is' : 's are'} already in the chat, ` +
        'searchable by this id.',
    )
  }

  return lines
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

  // Which config this report is about, and whether the session in it can be read. Printed
  // unconditionally: status never said where it looked before, and a row that shows up only
  // when something is unusual reads as a warning rather than as a fact.
  log(
    row(
      'Session',
      config.sealed
        ? `${configFile(configDir)} (sealed — opened with a passphrase)`
        : configFile(configDir),
    ),
  )
  log(row('Account', await accountLine(config, settings?.verbose ?? false, { connect, disconnect })))
  log(
    row(
      'Destination',
      settingsError ??
        (settings.chat === null
          ? 'none set — run "npx telstore config chat @my_backups" to set one'
          : describeChat(settings.chat)),
    ),
  )

  const states = await listStates(configDir)

  if (states.length === 0) {
    log(row('Unfinished', 'none'))
    return
  }

  log(row('Unfinished', `${states.length} backup${states.length === 1 ? '' : 's'}`))

  // The destination is what decides whether the resume command needs a --chat. A row that
  // failed to parse leaves nothing to compare against, which is not the same as a match.
  const destination = settings?.chat ?? null

  for (const { key, state } of states) {
    const total = countChunks(state.size, state.chunkSize)
    const done = Object.keys(state.done ?? {}).length

    log('')
    log(`  ${state.id}`)
    log(field('File', `${state.path}  (${formatBytes(state.size)})`))
    log(field('Chunks', `${done} of ${total} uploaded`))
    log(field('Chat', describeChat(state.chat)))

    for (const line of await resumeLines(key, state, destination, done)) log(line)
  }
}
