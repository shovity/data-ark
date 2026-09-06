import { normalizeChatTarget } from './chat.js'
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  parseSize,
} from './chunking.js'
import { formatBytes } from './progress.js'

export const DEFAULT_LIMIT = 20

// The three keys telark writes for itself. Naming them separately is what lets the
// unknown-key error say "managed by login" instead of listing a session as something the
// user forgot to spell correctly.
const MANAGED_BY_LOGIN = new Set(['session', 'apiId', 'apiHash'])

function wholeNumber(raw, where, minimum, maximum, explanation) {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error(`Invalid ${where}: ${JSON.stringify(raw)}. ${explanation}`)
  }

  const value = Number(String(raw).trim())

  if (!Number.isInteger(value) || value < minimum || (maximum !== null && value > maximum)) {
    throw new Error(`Invalid ${where}: "${raw}". ${explanation}`)
  }

  return value
}

// One entry per setting: the flag that overrides it for a run, the built-in default, the
// parser that both the flag and the stored value go through, and how the value is written
// back out. `format` must round-trip — whatever it prints has to parse to the same value,
// which is why chunkSize prints bytes and leaves "1.8 GB" to `describe`.
export const SETTINGS = {
  chat: {
    flag: 'to',
    default: null,
    // A number here is a chat id, and a chat id is a whole number. 42.5 would otherwise
    // slip through as the string "42.5" and only fail much later, at Telegram, as a chat
    // that does not exist.
    parse(raw, where) {
      const usable = typeof raw === 'string' || (typeof raw === 'number' && Number.isInteger(raw))

      if (!usable) {
        throw new Error(
          `Invalid ${where}: ${JSON.stringify(raw)}. A destination is @username, -100123..., or me.`,
        )
      }

      return normalizeChatTarget(raw)
    },
    format: (value) => String(value),
  },
  chunkSize: {
    flag: 'chunk-size',
    default: DEFAULT_CHUNK_SIZE,
    parse(raw, where) {
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        throw new Error(
          `Invalid ${where}: ${JSON.stringify(raw)}. Valid examples: 1800MB, 1.8GB, 524288.`,
        )
      }

      try {
        return parseSize(raw)
      } catch (err) {
        throw new Error(`Invalid ${where}: "${raw}". ${err.message}`)
      }
    },
    // Bytes, not "1.8 GB": formatBytes rounds to one decimal, so the pretty form parses
    // back to a different size and `config chunkSize` would print a value that, typed in
    // again, cuts the file differently.
    format: (value) => String(value),
    describe: (value) => formatBytes(value),
  },
  concurrency: {
    flag: 'concurrency',
    default: DEFAULT_CONCURRENCY,
    parse: (raw, where) =>
      wholeNumber(
        raw,
        where,
        1,
        MAX_CONCURRENCY,
        `Must be an integer from 1 to ${MAX_CONCURRENCY} — each slot holds a 512KB part in RAM ` +
          'and Telegram answers with FLOOD_WAIT if too many requests go out at once.',
      ),
    format: (value) => String(value),
  },
  limit: {
    flag: 'limit',
    default: DEFAULT_LIMIT,
    parse: (raw, where) =>
      wholeNumber(raw, where, 1, null, 'Must be a whole number of backups, 1 or more.'),
    format: (value) => String(value),
  },
  verbose: {
    flag: 'verbose',
    default: false,
    parse(raw, where) {
      if (typeof raw === 'boolean') return raw

      const text = String(raw).trim().toLowerCase()

      if (text === 'true') return true
      if (text === 'false') return false

      throw new Error(`Invalid ${where}: ${JSON.stringify(raw)}. Must be true or false.`)
    },
    format: (value) => String(value),
  },
}

export const SETTING_KEYS = Object.keys(SETTINGS)

// Someone who has been typing `--to` and `--chunk-size` for a week will type them at the
// config command too. Accept the flag spelling as a way in, and canonicalise on the way to
// disk so the file only ever holds one name per setting.
const ALIASES = new Map()

for (const [key, spec] of Object.entries(SETTINGS)) {
  ALIASES.set(key.toLowerCase(), key)
  ALIASES.set(spec.flag.toLowerCase(), key)
}

export function canonicalKey(input) {
  return ALIASES.get(String(input).trim().toLowerCase()) ?? null
}

export function isManagedByLogin(input) {
  return MANAGED_BY_LOGIN.has(String(input).trim())
}

// Where a value came from, spelled the way the user would recognise it. A stored value that
// fails to parse must not be reported as a bad flag: nobody typed a flag, and telling them
// to fix one sends them off after the wrong thing — the same mistake the old
// "run again without --to" advice made.
function origin(key, from, file) {
  return from === 'flag' ? `--${SETTINGS[key].flag}` : `${key} in ${file}`
}

// Precedence is flag, then the stored setting, then the built-in default. `source` is not
// decoration: an unfinished upload has to tell "you asked for this size" from "this is
// merely your default", and only the source separates them.
export function resolveSettings(options = {}, config = {}, { file = 'the config file' } = {}) {
  const values = {}
  const sources = {}
  const stored = config.settings ?? {}

  for (const [key, spec] of Object.entries(SETTINGS)) {
    const flagValue = options[spec.flag]

    if (flagValue !== undefined) {
      values[key] = spec.parse(flagValue, origin(key, 'flag', file))
      sources[key] = 'flag'
    } else if (stored[key] !== undefined) {
      values[key] = spec.parse(stored[key], origin(key, 'settings', file))
      sources[key] = 'settings'
    } else {
      values[key] = spec.default
      sources[key] = 'default'
    }
  }

  return {
    values,
    // Throws rather than returning undefined for a typo: a misspelt key at the chunk-size
    // call site would turn "refuse to resume at a different size" into "resume at a
    // different size", silently, which is the one thing this project must never do.
    source(key) {
      if (!(key in sources)) {
        throw new Error(`Unknown setting: ${key}. Known settings: ${SETTING_KEYS.join(', ')}.`)
      }

      return sources[key]
    },
  }
}

export function requireChat(values) {
  if (values.chat === null || values.chat === undefined) {
    throw new Error(
      'No destination set — run "npx telark config chat @my_backups" to set one ' +
        '("config chat me" for Saved Messages), or pass --to to choose one for this run.',
    )
  }

  return values.chat
}
