import test from 'node:test'
import assert from 'node:assert/strict'

import { runStatus } from '../src/commands/status.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { saveState } from '../src/state.js'

import { LOGGED_IN, collect, tempDir } from './helpers.js'

function fakeClient(me = { firstName: 'Sho', username: 'shovity' }) {
  return { async getMe() { return me } }
}

test('status without a login says so and never opens a connection', async () => {
  const configDir = await tempDir('status')
  const out = collect()
  let connected = false

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => { connected = true; return fakeClient() },
    disconnect: async () => {},
  })

  assert.equal(connected, false)
  assert.match(out.text(), /Not logged in/)
})

test('status reports the account, the destination and nothing unfinished', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /Sho \(@shovity\)/)
  assert.match(text, /@my_backups/)
  assert.match(text, /none/i)
})

test('an expired session is reported, not thrown', async () => {
  const configDir = await tempDir('status')
  await saveConfig(LOGGED_IN, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => { throw new Error('Session expired — run "npx telark login".') },
    disconnect: async () => {},
  })

  assert.match(out.text(), /Session expired/)
})

test('status lists each unfinished backup with how far it got', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@my_backups' } }, configDir)
  await saveState('aaa', {
    id: 'telark-20260905-02e053',
    chat: '@my_backups',
    path: '/home/ai/data.tar',
    size: 100,
    mtimeMs: 1,
    chunkSize: 40,
    done: { 0: {}, 1: {} },
  }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /telark-20260905-02e053/)
  assert.match(text, /data\.tar/)
  // 100 bytes in 40-byte chunks is three chunks, two of them already sent.
  assert.match(text, /2\/3/)
})

test('the connection is closed even when getMe fails', async () => {
  const configDir = await tempDir('status')
  await saveConfig(LOGGED_IN, configDir)
  const out = collect()
  let closed = false

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => ({ async getMe() { throw new Error('AUTH_KEY_UNREGISTERED') } }),
    disconnect: async () => { closed = true },
  })

  assert.equal(closed, true)
  assert.match(out.text(), /AUTH_KEY_UNREGISTERED/)
})

test('status --to reports that destination without saving it', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@old' } }, configDir)
  const out = collect()

  await runStatus({ to: '@new' }, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Destination\s+https:\/\/web\.telegram\.org\/k\/#@new/)
  assert.doesNotMatch(out.text(), /@old/)
  assert.equal((await loadConfig(configDir)).settings.chat, '@old', 'a flag must never write')
})

test('status --to with an unusable destination is refused, not shown', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@old' } }, configDir)
  const out = collect()

  await runStatus({ to: '  ' }, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Destination\s+.*must not be empty/)
  assert.equal((await loadConfig(configDir)).settings.chat, '@old')
})

// status is the one command someone runs because something is already wrong, so a setting
// it cannot parse belongs in its own row — not in an exception that hides the account line
// and the unfinished backups underneath it.
test('a stored setting that cannot be parsed is reported in its row, not thrown', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: 42.5 } }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Account/)
  assert.match(out.text(), /Unfinished/)
  assert.match(out.text(), /chat in .*config\.json/)
})

test('the destination is shown as a link that can be clicked', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '-5107543795' } }, configDir)
  await saveState('aaa', {
    id: 'telark-1',
    chat: '@my_backups',
    path: '/home/ai/data.tar',
    size: 100,
    mtimeMs: 1,
    chunkSize: 40,
    done: {},
  }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  const text = out.text()
  assert.match(text, /Destination\s+https:\/\/web\.telegram\.org\/k\/#-5107543795/)
  // The unfinished backup goes to a different chat, and follows the same form.
  assert.match(text, /https:\/\/web\.telegram\.org\/k\/#@my_backups/)
})

test('Saved Messages is named rather than linked', async () => {
  const configDir = await tempDir('status')
  await saveConfig({ ...LOGGED_IN, settings: { chat: 'me' } }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Destination\s+me \(Saved Messages\)/)
})
