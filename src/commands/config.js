import {
  SETTINGS,
  SETTING_KEYS,
  canonicalKey,
  isManagedByLogin,
  resolveSettings,
} from '../settings.js'
import { configFile, defaultConfigDir, loadConfig, saveConfig } from '../config.js'

const GAP = '  '

function unknownKey(name) {
  if (isManagedByLogin(name)) {
    return new Error(
      `"${name}" is managed by "npx data-ark login", not by config. ` +
        `Settings you can change: ${SETTING_KEYS.join(', ')}.`,
    )
  }

  return new Error(`Unknown setting: "${name}". Settings are: ${SETTING_KEYS.join(', ')}.`)
}

// Every setting, resolved, with where the value came from. A stored value and a built-in
// default look identical once resolved, and the difference is the whole question someone
// runs this command to answer.
function listLines(values, source, stored) {
  const rows = SETTING_KEYS.map((key) => {
    const spec = SETTINGS[key]
    const value = values[key]

    // chat is the one setting with no default, so "(default)" beside it would name a
    // fallback that does not exist. It is either set or it is not.
    if (value === null) return [key, 'not set', '']

    const note = spec.describe ? ` (${spec.describe(value)})` : ''

    return [key, `${spec.format(value)}${note}`, source(key) === 'settings' ? '' : '(default)']
  })

  // Keys data-ark does not know are left in the file untouched, but a value that silently
  // does nothing is worse than one that is refused: show them, so a typo is visible from
  // the command rather than only from opening the file that also holds the session.
  const strays = Object.keys(stored).filter((key) => !SETTING_KEYS.includes(key))

  const widths = [0, 1].map((i) => Math.max(...rows.map((row) => row[i].length)))
  const lines = rows.map((row) =>
    `${row[0].padEnd(widths[0])}${GAP}${row[1].padEnd(widths[1])}${GAP}${row[2]}`.trimEnd(),
  )

  if (strays.length > 0) {
    lines.push('')
    lines.push(
      `Ignored, data-ark does not know these: ${strays.join(', ')}. ` +
        'Remove one with: npx data-ark config <name> --unset',
    )
  }

  return lines
}

export async function runConfig(args = [], options = {}, deps = {}) {
  const { configDir = defaultConfigDir(), log = (line) => console.log(line) } = deps
  const [name, value, ...extra] = args

  if (extra.length > 0) {
    throw new Error(
      `Too many arguments: a setting takes one value, but got ${args.length}. ` +
        `Did you mean: npx data-ark config ${name} "${[value, ...extra].join(' ')}"`,
    )
  }

  // Both of these would otherwise be obeyed halfway and reported as a success: a listing
  // that quietly dropped the --unset, or an unset that quietly dropped the value beside it.
  if (options.unset && name === undefined) {
    throw new Error('--unset needs the setting to drop. Try: npx data-ark config chat --unset')
  }

  if (options.unset && value !== undefined) {
    throw new Error(
      `--unset takes no value, but "${value}" was given. ` +
        `Use "npx data-ark config ${name} --unset" to drop it, ` +
        `or "npx data-ark config ${name} ${value}" to set it.`,
    )
  }

  const file = configFile(configDir)
  const config = await loadConfig(configDir)
  const stored = config.settings ?? {}

  if (name === undefined) {
    const { values, source } = resolveSettings({}, config, { file })
    for (const line of listLines(values, source, stored)) log(line)
    return
  }

  const key = canonicalKey(name)

  // --unset has to reach a key the registry does not know: the listing above points at
  // strays, and this is the only way to remove one without opening the file by hand.
  if (options.unset) {
    if (!key && stored[name] === undefined) throw unknownKey(name)

    const target = key ?? name
    const next = { ...stored }
    delete next[target]

    await saveConfig({ ...config, settings: next }, configDir)
    log(`${target} unset.`)
    return
  }

  if (!key) throw unknownKey(name)

  if (value === undefined) {
    // The bare value and nothing else, so this can be read by a script. An unset key
    // reports the default that will actually be used; chat has no default, so it says
    // nothing rather than inventing one.
    const { values } = resolveSettings({}, config, { file })
    if (values[key] !== null) log(SETTINGS[key].format(values[key]))
    return
  }

  // Parse before writing: an unusable value must never reach the file, or the next command
  // fails over something the user was told had been saved.
  const parsed = SETTINGS[key].parse(value, key)

  await saveConfig({ ...config, settings: { ...stored, [key]: parsed } }, configDir)

  log(`${key} = ${SETTINGS[key].format(parsed)}`)
}
