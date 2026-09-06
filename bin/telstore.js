#!/usr/bin/env node
import { route, HELP, interruptMessage } from '../src/cli.js'
import { runLogin } from '../src/commands/login.js'
import { runConfig } from '../src/commands/config.js'
import { runDelete } from '../src/commands/delete.js'
import { runList } from '../src/commands/list.js'
import { runLogout } from '../src/commands/logout.js'
import { runRestore } from '../src/commands/restore.js'
import { runStatus } from '../src/commands/status.js'
import { runUpload } from '../src/commands/upload.js'

const SIGINT_EXIT_CODE = 130

// Which command is running when Ctrl-C arrives — each one tells a different truth
// about whether progress was saved, so we need to know which to pick the right line.
// The backup id arrives a moment later, once upload knows which backup this run is.
let currentCommand = null
let currentBackupId = null

process.on('SIGINT', () => {
  process.stderr.write(interruptMessage(currentCommand, { backupId: currentBackupId }))
  process.exit(SIGINT_EXIT_CODE)
})

async function main() {
  let parsed

  try {
    parsed = route(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }

  currentCommand = parsed.command

  switch (parsed.command) {
    case 'help':
      process.stdout.write(HELP)
      return

    case 'login':
      await runLogin({ verbose: Boolean(parsed.options.verbose) })
      return

    case 'logout':
      await runLogout()
      return

    case 'list':
      await runList(parsed.options)
      return

    case 'status':
      await runStatus(parsed.options)
      return

    case 'config':
      await runConfig(parsed.args, parsed.options)
      return

    case 'upload':
      await runUpload(parsed.args[0], parsed.options, {
        onBackupId: (id) => {
          currentBackupId = id
        },
      })
      return

    case 'restore':
      if (!parsed.args[0]) {
        throw new Error('Missing backup id. Example: npx telstore restore telstore-20260905-7f3a91')
      }
      await runRestore(parsed.args[0], parsed.options)
      return

    case 'delete':
      if (!parsed.args[0]) {
        throw new Error('Missing backup id. Example: npx telstore delete telstore-20260905-7f3a91')
      }
      await runDelete(parsed.args[0], parsed.options)
      return

    default:
      throw new Error(`Unknown command: ${parsed.command}`)
  }
}

// GramJS keeps "exported senders" around together with a 30-second timer to release
// them, and neither client.disconnect() nor destroy() cleans them up: both of those
// maps are Maps, but the code walks them with Object.values and so misses everything.
// The result is a command that prints "Done" and then hangs for another ~30 seconds,
// during which Ctrl-C falsely reports that nothing was saved. Finish the work, exit.
function exitWhenFlushed(code) {
  // The empty writes exist only to borrow their callbacks: they fire after everything
  // queued earlier has flushed, so nothing is lost when stdout/stderr is not a TTY.
  let pending = 2

  const done = () => {
    pending -= 1
    if (pending === 0) process.exit(code)
  }

  // Safety net: exit anyway if a callback never arrives (the pipe is already closed).
  setTimeout(() => process.exit(code), 2000).unref()

  process.stdout.write('', done)
  process.stderr.write('', done)
}

main().then(
  () => {
    exitWhenFlushed(process.exitCode ?? 0)
  },
  (err) => {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exitCode = 1
    exitWhenFlushed(1)
  },
)
