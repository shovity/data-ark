import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { runConfig } from '../src/commands/config.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { collect, tempDir } from './helpers.js'

const deps = (configDir, out) => ({ configDir, log: out.log })

test('with no arguments every setting is listed with where its value came from', async () => {
  const configDir = await tempDir('config')
  await saveConfig({ session: 's', settings: { chat: '@store' } }, configDir)
  const out = collect()

  await runConfig([], {}, deps(configDir, out))

  assert.match(out.text(), /chat\s+@store$/m)
  assert.doesNotMatch(out.text(), /chat.*\(default\)/)
  assert.match(out.text(), /uploadConcurrency\s+32\s+\(default\)/)
  assert.match(out.text(), /downloadConcurrency\s+8\s+\(default\)/)
  assert.match(out.text(), /limit\s+20\s+\(default\)/)
})

// The listing prints values; the session is not one. Nothing that reaches this command can
// walk past a credential, because it only ever reads inside `settings`.
test('the listing never shows a credential', async () => {
  const configDir = await tempDir('config')
  await saveConfig({ session: 'secret-session', apiHash: 'secret-hash' }, configDir)
  const out = collect()

  await runConfig([], {}, deps(configDir, out))

  assert.doesNotMatch(out.text(), /secret-session|secret-hash|session|apiHash/)
})

test('one setting prints its bare value, so a script can read it', async () => {
  const configDir = await tempDir('config')
  await saveConfig({ settings: { chat: '@store' } }, configDir)
  const out = collect()

  await runConfig(['chat'], {}, deps(configDir, out))

  assert.equal(out.text(), '@store')
})

test('a setting that was never set prints the default that will actually be used', async () => {
  const configDir = await tempDir('config')
  const out = collect()

  await runConfig(['limit'], {}, deps(configDir, out))

  assert.equal(out.text(), '20')
})

// chat is the one setting with no default, so there is nothing true to print. Inventing a
// destination would be worse than saying nothing.
test('a destination that was never set prints nothing rather than a guess', async () => {
  const configDir = await tempDir('config')
  const out = collect()

  await runConfig(['chat'], {}, deps(configDir, out))

  assert.equal(out.text(), '')
})

test('setting a value writes it and confirms what was written', async () => {
  const configDir = await tempDir('config')
  const out = collect()

  await runConfig(['chat', '@my_backups'], {}, deps(configDir, out))

  assert.equal((await loadConfig(configDir)).settings.chat, '@my_backups')
  assert.match(out.text(), /chat = @my_backups/)
})

test('a negative channel id is stored as the number it is', async () => {
  const configDir = await tempDir('config')
  const out = collect()

  await runConfig(['chat', '-1001234567890'], {}, deps(configDir, out))

  assert.equal((await loadConfig(configDir)).settings.chat, -1001234567890)
})

// formatBytes rounds to one decimal, so printing "1.8 GB" here would hand back a value
// that parses to a different chunk size than the one that was set.
test('a chunk size read back is the same chunk size when typed in again', async () => {
  const configDir = await tempDir('config')

  await runConfig(['chunkSize', '1800MB'], {}, deps(configDir, collect()))

  const first = collect()
  await runConfig(['chunkSize'], {}, deps(configDir, first))
  assert.equal(first.text(), String(1800 * 1024 * 1024))

  await runConfig(['chunkSize', first.text()], {}, deps(configDir, collect()))
  assert.equal((await loadConfig(configDir)).settings.chunkSize, 1800 * 1024 * 1024)
})

test('the listing spells a chunk size out as well as printing it exactly', async () => {
  const configDir = await tempDir('config')
  await runConfig(['chunkSize', '500MB'], {}, deps(configDir, collect()))
  const out = collect()

  await runConfig([], {}, deps(configDir, out))

  assert.match(out.text(), /chunkSize\s+524288000 \(500\.0 MB\)/)
})

test('the flag spelling of a setting is accepted and canonicalised on the way in', async () => {
  const configDir = await tempDir('config')

  await runConfig(['to', '@my_backups'], {}, deps(configDir, collect()))
  await runConfig(['chunk-size', '500MB'], {}, deps(configDir, collect()))

  const { settings } = await loadConfig(configDir)
  assert.deepEqual(Object.keys(settings).sort(), ['chat', 'chunkSize'])
})

// A value that cannot be used must never reach the file, or the next command fails over
// something the user was told had been saved.
test('a value that cannot be used is refused before anything is written', async () => {
  const configDir = await tempDir('config')
  await saveConfig({ settings: { chunkSize: 400 } }, configDir)

  await assert.rejects(() => runConfig(['chunkSize', '9GB'], {}, deps(configDir, collect())), /1950MB/)
  await assert.rejects(
    () => runConfig(['uploadConcurrency', '0'], {}, deps(configDir, collect())),
    /1 to 64/,
  )
  await assert.rejects(() => runConfig(['chat', '  '], {}, deps(configDir, collect())), /must not be empty/)

  assert.deepEqual((await loadConfig(configDir)).settings, { chunkSize: 400 })
})

test('unsetting a setting removes it and falls back to the default', async () => {
  const configDir = await tempDir('config')
  await saveConfig({ session: 's', settings: { chat: '@store', limit: 5 } }, configDir)
  const out = collect()

  await runConfig(['limit'], { unset: true }, deps(configDir, out))

  const config = await loadConfig(configDir)
  assert.deepEqual(config.settings, { chat: '@store' })
  assert.equal(config.session, 's', 'unsetting a setting must not touch the session')
  assert.match(out.text(), /limit unset/)
})

test('unsetting something that was never set says so rather than failing', async () => {
  const configDir = await tempDir('config')

  await runConfig(['limit'], { unset: true }, deps(configDir, collect()))

  assert.deepEqual((await loadConfig(configDir)).settings, {})
})

// The listing shows keys telstore does not know so a typo is visible from the command
// rather than only from opening the file that also holds the session — which means --unset
// has to reach them too, or the only cure is that same file.
test('a setting telstore does not know is shown, and can be removed', async () => {
  const configDir = await tempDir('config')
  await saveConfig({ settings: { chat: 'me', chukSize: '500MB' } }, configDir)
  const shown = collect()

  await runConfig([], {}, deps(configDir, shown))
  assert.match(shown.text(), /Ignored, telstore does not know these: chukSize/)

  await runConfig(['chukSize'], { unset: true }, deps(configDir, collect()))
  assert.deepEqual((await loadConfig(configDir)).settings, { chat: 'me' })
})

test('an unknown setting is refused with the list of real ones', async () => {
  const configDir = await tempDir('config')

  await assert.rejects(() => runConfig(['nonsense', 'x'], {}, deps(configDir, collect())), (err) => {
    assert.match(err.message, /Unknown setting: "nonsense"/)
    assert.match(err.message, /chat, chunkSize, uploadConcurrency, downloadConcurrency, limit, verbose/)
    return true
  })
})

test('a credential is named as login business rather than as a misspelling', async () => {
  const configDir = await tempDir('config')

  await assert.rejects(
    () => runConfig(['session', 'x'], {}, deps(configDir, collect())),
    /managed by "npx telstore login"/,
  )
})

// The `--` that rescues a negative channel id ends option parsing, so a flag written after
// one arrives as a third argument. Refusing it by name beats an error about "-1".
test('an extra argument is refused by name instead of being ignored', async () => {
  const configDir = await tempDir('config')

  await assert.rejects(
    () => runConfig(['chat', '-100123', '--verbose'], {}, deps(configDir, collect())),
    /Too many arguments/,
  )

  await assert.rejects(
    () => fs.readFile(path.join(configDir, 'config.json'), 'utf8'),
    { code: 'ENOENT' },
  )
})
