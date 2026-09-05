import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig, saveConfig, clearSession, defaultConfigDir } from '../src/config.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-config-'))
}

test('defaultConfigDir points at ~/.data-ark', () => {
  assert.equal(defaultConfigDir(), path.join(os.homedir(), '.data-ark'))
})

test('loadConfig returns an empty object when there is no file yet', async () => {
  const dir = await tempDir()
  assert.deepEqual(await loadConfig(dir), {})
})

test('saveConfig then loadConfig round-trips the data', async () => {
  const dir = await tempDir()
  const config = { apiId: 12345, apiHash: 'abc', session: 'sess', defaultChat: '@store' }

  await saveConfig(config, dir)

  assert.deepEqual(await loadConfig(dir), config)
})

test('saveConfig creates a directory that does not exist yet', async () => {
  const dir = path.join(await tempDir(), 'does', 'not', 'exist')

  await saveConfig({ defaultChat: 'me' }, dir)

  assert.deepEqual(await loadConfig(dir), { defaultChat: 'me' })
})

test('the config file is readable and writable by its owner only', async () => {
  const dir = await tempDir()

  await saveConfig({ session: 'secret' }, dir)

  const stat = await fs.stat(path.join(dir, 'config.json'))
  assert.equal(stat.mode & 0o777, 0o600)
})

test('saveConfig leaves no temporary file behind', async () => {
  const dir = await tempDir()

  await saveConfig({ defaultChat: 'me' }, dir)

  assert.deepEqual(await fs.readdir(dir), ['config.json'])
})

test('clearSession drops the session but keeps everything else', async () => {
  const dir = await tempDir()
  await saveConfig({ apiId: 1, apiHash: 'h', session: 's', defaultChat: '@store' }, dir)

  await clearSession(dir)

  assert.deepEqual(await loadConfig(dir), { apiId: 1, apiHash: 'h', defaultChat: '@store' })
})

test('loadConfig gives a clear error when the file is corrupt', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'config.json'), '{ broken')

  await assert.rejects(() => loadConfig(dir), /Corrupt config file/)
})
