import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearSession,
  defaultConfigDir,
  loadConfig,
  checkConfigShape,
  saveConfig,
} from '../src/config.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'telstore-config-'))
}

test('defaultConfigDir points at ~/.telstore', () => {
  assert.equal(defaultConfigDir(), path.join(os.homedir(), '.telstore'))
})

test('loadConfig returns an empty object when there is no file yet', async () => {
  const dir = await tempDir()
  assert.deepEqual(await loadConfig(dir), {})
})

test('saveConfig then loadConfig round-trips the data', async () => {
  const dir = await tempDir()
  const config = { apiId: 12345, apiHash: 'abc', session: 'sess', settings: { chat: '@store' } }

  await saveConfig(config, dir)

  assert.deepEqual(await loadConfig(dir), config)
})

test('saveConfig creates a directory that does not exist yet', async () => {
  const dir = path.join(await tempDir(), 'does', 'not', 'exist')

  await saveConfig({ settings: { chat: 'me' } }, dir)

  assert.deepEqual(await loadConfig(dir), { settings: { chat: 'me' } })
})

test('the config file is readable and writable by its owner only', async () => {
  const dir = await tempDir()

  await saveConfig({ session: 'secret' }, dir)

  const stat = await fs.stat(path.join(dir, 'config.json'))
  assert.equal(stat.mode & 0o777, 0o600)
})

test('saveConfig leaves no temporary file behind', async () => {
  const dir = await tempDir()

  await saveConfig({ settings: { chat: 'me' } }, dir)

  assert.deepEqual(await fs.readdir(dir), ['config.json'])
})

test('clearSession drops the session but keeps everything else', async () => {
  const dir = await tempDir()
  await saveConfig({ apiId: 1, apiHash: 'h', session: 's', settings: { chat: '@store' } }, dir)

  await clearSession(dir)

  assert.deepEqual(await loadConfig(dir), { apiId: 1, apiHash: 'h', settings: { chat: '@store' } })
})

test('loadConfig gives a clear error when the file is corrupt', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'config.json'), '{ broken')

  await assert.rejects(() => loadConfig(dir), /Corrupt config file/)
})

test('a config with a settings group is handed back as it is', () => {
  assert.deepEqual(checkConfigShape({ apiId: 1, settings: { chat: 'me' } }, 'f.json'), {
    apiId: 1,
    settings: { chat: 'me' },
  })
})

test('settings telstore does not know are left exactly where they were found', () => {
  assert.deepEqual(checkConfigShape({ settings: { chat: 'me', future: 1 } }, 'f.json'), {
    settings: { chat: 'me', future: 1 },
  })
})

// `config.settings?.chat` on a number is undefined, so a settings key holding the wrong
// kind of value would have telstore run cheerfully on built-in defaults while the user's
// own choices sat in the file being ignored. Name it instead.
test('a settings key that is not a group of settings is named, not stepped over', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'config.json'), '{"session":"s","settings":5}')

  await assert.rejects(() => loadConfig(dir), (err) => {
    assert.match(err.message, /"settings" in .*config\.json/)
    assert.match(err.message, /number/)
    return true
  })
})

test('a config file holding a list rather than an object is refused', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'config.json'), '[1,2]')

  await assert.rejects(() => loadConfig(dir), /holds a list/)
})

// The old advice for a syntax error was "delete it and run login again", written when
// nothing but telstore touched this file. `config` invites people to edit it by hand, and a
// stray comma is not a reason to throw someone's session away.
test('a syntax error asks for the syntax to be fixed before it offers to delete the session', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'config.json'), '{"session": "s",}')

  await assert.rejects(() => loadConfig(dir), (err) => {
    assert.match(err.message, /not valid JSON/)
    assert.match(err.message, /Fix the syntax to keep your session/)
    return true
  })
})
