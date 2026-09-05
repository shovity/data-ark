import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runSetDestination } from '../src/commands/set-destination.js'
import { loadConfig, saveConfig } from '../src/config.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-dest-'))
}

test('the destination is written to the config and confirmed', async () => {
  const configDir = await tempDir()
  const lines = []

  await runSetDestination({ to: '@my_backups' }, { configDir, log: (l) => lines.push(l) })

  assert.equal((await loadConfig(configDir)).defaultChat, '@my_backups')
  assert.match(lines.join('\n'), /@my_backups/)
})

test('a negative channel id is stored as given', async () => {
  const configDir = await tempDir()

  await runSetDestination({ to: '-1001234567890' }, { configDir, log: () => {} })

  assert.equal((await loadConfig(configDir)).defaultChat, '-1001234567890')
})

test('setting a destination keeps the rest of the config', async () => {
  const configDir = await tempDir()
  await saveConfig({ session: 's', apiId: 1, apiHash: 'h', defaultChat: '@old' }, configDir)

  await runSetDestination({ to: 'me' }, { configDir, log: () => {} })

  const config = await loadConfig(configDir)
  assert.equal(config.defaultChat, 'me')
  assert.equal(config.session, 's')
  assert.equal(config.apiId, 1)
})

test('an empty destination is rejected before anything is written', async () => {
  const configDir = await tempDir()

  await assert.rejects(() => runSetDestination({ to: '   ' }, { configDir, log: () => {} }), /must not be empty/)
  assert.deepEqual(await loadConfig(configDir), {})
})
