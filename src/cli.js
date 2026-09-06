import { parseArgs } from 'node:util'

const SUBCOMMANDS = new Set([
  'login',
  'logout',
  'list',
  'restore',
  'delete',
  'status',
  'config',
  'token',
  'help',
])

const OPTIONS = {
  to: { type: 'string' },
  'chunk-size': { type: 'string' },
  'upload-concurrency': { type: 'string' },
  'download-concurrency': { type: 'string' },
  out: { type: 'string' },
  limit: { type: 'string' },
  verbose: { type: 'boolean' },
  unset: { type: 'boolean' },
  yes: { type: 'boolean' },
  token: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

export const HELP = `telstore — split large files into chunks and store them on Telegram

Usage:
  npx telstore login                      Log in to Telegram, only needed once
  npx telstore <file>                     Split a file and upload it to Telegram
  npx telstore list                       List the backups stored in the destination
  npx telstore restore <backup-id>        Download the chunks and reassemble the file
  npx telstore delete <backup-id>         Remove a backup's chunks and manifest from the chat
  npx telstore status                     Show the account, the destination and unfinished backups
  npx telstore config                     Show every setting and where its value comes from
  npx telstore logout                     Remove the saved session

Running on a machine you do not trust:
  npx telstore token                      Print a session token for another machine
  npx telstore login --token              Log in there by pasting one, session stays sealed

Settings:
  npx telstore config <name>              Print one setting's value
  npx telstore config <name> <value>      Change it for good
  npx telstore config <name> --unset      Drop it and fall back to the default

  chat                 Where backups go: @username, -100123..., or me. No default.
  chunkSize            Size of each chunk, default 1800MB. Examples: 1.8GB, 500MB.
  uploadConcurrency    512KB parts sent in parallel, default 32, max 64.
  downloadConcurrency  8MB slices fetched in parallel, default 8, max 64.
  limit                How many backups list shows, default 20.
  verbose              Show Telegram connection logs, default false.

Options apply to one run and are never saved. Use config to change a setting for good.
  --to <chat>                 Destination for this run only.
  --chunk-size <n>            Chunk size for this run only. An unfinished backup keeps the
                              size it started with.
  --upload-concurrency <n>    512KB parts in parallel while uploading, this run only.
  --download-concurrency <n>  8MB slices in parallel while restoring, this run only.
  --out <path>                Where to write the restored file. Defaults to the basename in
                              the manifest.
  --limit <n>                 How many backups list shows this run.
  --token                     Log in by pasting a session token. It takes no value on
                              purpose: a token written on the command line would sit in
                              "ps" for the whole life of the command, and stay in that
                              machine's shell history afterwards.
  --yes                       Delete without asking to confirm first.
  --verbose                   Show Telegram connection logs for this run.
  -h, --help                  Show this help.
`

// What Ctrl-C means depends on the command that was running: upload has written every
// finished chunk to a state file, restore has not. Naming the backup matters because the
// id is what `status` lists and what a later `restore` needs — the chunks are already in
// the chat under that id, whether or not this run ever finishes.
export function interruptMessage(command, { backupId } = {}) {
  if (command === 'upload') {
    const backup = backupId ? `Backup ${backupId} is saved` : 'Progress is saved'

    return (
      `\n${backup} — run the same command again to continue, ` +
      'or "npx telstore status" to see what is left.\n'
    )
  }

  if (command === 'restore') {
    return '\nStopped. Download progress is not saved, running again starts over.\n'
  }

  // A delete has already destroyed messages for good by the time Ctrl-C lands, and the
  // manifest is deliberately still there — it is what a second run reads to finish. Saying
  // only "Stopped." would read as "nothing happened", which is the one thing it never means.
  if (command === 'delete') {
    return (
      '\nStopped. Some chunk messages are already gone — run the same command again to ' +
      'finish removing the backup.\n'
    )
  }

  return '\nStopped.\n'
}

// A channel id is negative, and typing it separated by a space is the natural reflex — but
// parseArgs rejects anything starting with a dash as an option, and reports it as one:
// `config chat -100123` fails with "Unknown option '-1'", naming a flag nobody typed.
//
// Two shapes need rescuing, and they are rescued differently. As a flag value, `--to -100123`
// is joined into `--to=-100123`; only a bare negative integer qualifies, so `--to --verbose`
// still reports the missing value instead of eating the next flag. As a positional —
// `config chat -100123` — there is nothing to join it to, so `--` goes in front and the rest
// of the line is handed over verbatim. That is greedy on purpose: a flag written after the
// id becomes a positional too, and runConfig refuses the extra argument by name, which beats
// an error about `-1`.
//
// Everything after an explicit `--` is left alone, because it is no longer an option there.
function protectNegativeChatIds(argv) {
  const safe = []

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--') {
      safe.push(...argv.slice(i))
      return safe
    }

    if (argv[i] === '--to' && /^-\d+$/.test(argv[i + 1] ?? '')) {
      safe.push(`--to=${argv[i + 1]}`)
      i += 1
      continue
    }

    if (/^-\d+$/.test(argv[i])) {
      safe.push('--', ...argv.slice(i))
      return safe
    }

    safe.push(argv[i])
  }

  return safe
}

export function route(argv) {
  const { values, positionals } = parseArgs({
    args: protectNegativeChatIds(argv),
    options: OPTIONS,
    allowPositionals: true,
  })

  const [first, ...rest] = positionals

  // `telstore --to @chan` with no file used to mean "remember this destination". Flags no
  // longer write anything, so that line now asks for a run that has nothing to upload —
  // say where the destination actually lives instead of printing help at someone who was
  // perfectly clear about what they wanted.
  if (first === undefined && values.to && !values.help) {
    throw new Error(
      `Nothing to upload. To change the destination for good, run "npx telstore config chat ${values.to}". ` +
        'To use it for one run, pass --to alongside a file or a command.',
    )
  }

  if (values.help || first === undefined || first === 'help') {
    return { command: 'help', args: [], options: values }
  }

  if (SUBCOMMANDS.has(first)) {
    return { command: first, args: rest, options: values }
  }

  return { command: 'upload', args: [first], options: values }
}
