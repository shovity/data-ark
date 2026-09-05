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

// A channel id is negative, and typing it separated by a space is the natural reflex —
// but parseArgs rejects any value starting with a dash as ambiguous. Join the pair itself
// so `--to -100123` works like `--to=-100123`. Only a bare negative integer qualifies, so
// `--to --verbose` still reports the missing value instead of eating the next flag, and
// everything after `--` is left alone because it is no longer an option there.
function joinNegativeChatId(argv) {
  const joined = []

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--') {
      joined.push(...argv.slice(i))
      return joined
    }

    if (argv[i] === '--to' && /^-\d+$/.test(argv[i + 1] ?? '')) {
      joined.push(`--to=${argv[i + 1]}`)
      i += 1
      continue
    }

    joined.push(argv[i])
  }

  return joined
}

export function route(argv) {
  const { values, positionals } = parseArgs({
    args: joinNegativeChatId(argv),
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
