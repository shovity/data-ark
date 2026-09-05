import { parseArgs } from 'node:util'

const SUBCOMMANDS = new Set(['login', 'logout', 'restore', 'help'])

const OPTIONS = {
  to: { type: 'string' },
  'chunk-size': { type: 'string' },
  concurrency: { type: 'string' },
  out: { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

export const HELP = `data-ark — split large files into chunks and store them on Telegram

Usage:
  npx data-ark login                        Log in to Telegram, only needed once
  npx data-ark <file>                       Split a file and upload it to Telegram
  npx data-ark restore <backup-id>          Download the chunks and reassemble the file
  npx data-ark logout                       Remove the saved session

Options:
  --to <chat>            Destination: @username, -100123..., or me. Remembered for next time.
  --chunk-size <n>       Size of each chunk, default 1800MB. Examples: 1.8GB, 500MB.
  --concurrency <n>      512KB parts sent in parallel, default 8, max 64.
  --out <path>           Where to write the restored file. Defaults to the basename in the manifest.
  --verbose              Show Telegram connection logs, hidden by default.
  -h, --help             Show this help.
`

export function route(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  })

  const [first, ...rest] = positionals

  if (values.help || first === undefined || first === 'help') {
    return { command: 'help', args: [], options: values }
  }

  if (SUBCOMMANDS.has(first)) {
    return { command: first, args: rest, options: values }
  }

  return { command: 'upload', args: [first], options: values }
}
