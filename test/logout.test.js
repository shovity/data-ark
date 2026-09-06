import test from 'node:test'
import assert from 'node:assert/strict'

import { runLogout } from '../src/commands/logout.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { LOGGED_IN, collect, tempDir } from './helpers.js'

test('logout removes the session and keeps what login can reuse', async () => {
  const configDir = await tempDir('logout')
  const out = collect()
  await saveConfig({ ...LOGGED_IN, settings: { chat: 'me' } }, configDir)

  await runLogout({ configDir, log: out.log })

  assert.deepEqual(await loadConfig(configDir), { apiId: 1, apiHash: 'h', settings: { chat: 'me' } })
  assert.match(out.text(), /api_id, api_hash and the destination are kept/)
})

// A sealed config keeps the api_hash inside the blob, so removing the blob removes that too.
// Saying "api_hash is kept" there would describe a machine other than the one in front of you.
test('logout on a sealed session does not claim to have kept an api_hash it just deleted', async () => {
  const configDir = await tempDir('logout')
  const out = collect()
  await saveConfig({ sealed: 'tls1.abc', settings: { chat: 'me' } }, configDir)

  await runLogout({ configDir, log: out.log })

  assert.deepEqual(await loadConfig(configDir), { settings: { chat: 'me' } })
  assert.doesNotMatch(out.text(), /api_id, api_hash and the destination are kept/)
  assert.match(out.text(), /api_hash were inside it, so they are gone/)
  assert.match(out.text(), /Settings → Devices/)
})
