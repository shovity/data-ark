import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runStatus } from '../src/commands/status.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { saveState } from '../src/state.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-status-'))
}

function collect() {
  const lines = []
  return { lines, log: (line) => lines.push(line), text: () => lines.join('\n') }
}

const LOGGED_IN = {
  session: 's',
  apiId: 1,
  apiHash: 'h',
}

function fakeClient(me = { firstName: 'Sho', username: 'shovity' }) {
  return { async getMe() { return me } }
}

test('status without a login says so and never opens a connection', async () => {
  const configDir = await tempDir()
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
  const configDir = await tempDir()
  await saveConfig({ ...LOGGED_IN, defaultChat: '@my_backups' }, configDir)
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
  const configDir = await tempDir()
  await saveConfig(LOGGED_IN, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => { throw new Error('Session expired — run "npx data-ark login".') },
    disconnect: async () => {},
  })

  assert.match(out.text(), /Session expired/)
})

test('status lists each unfinished backup with how far it got', async () => {
  const configDir = await tempDir()
  await saveConfig({ ...LOGGED_IN, defaultChat: '@my_backups' }, configDir)
  await saveState('aaa', {
    id: 'ark-20260905-02e053',
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
  assert.match(text, /ark-20260905-02e053/)
  assert.match(text, /data\.tar/)
  // 100 bytes in 40-byte chunks is three chunks, two of them already sent.
  assert.match(text, /2\/3/)
})

test('the connection is closed even when getMe fails', async () => {
  const configDir = await tempDir()
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

test('status --to sets the destination first, then reports it', async () => {
  const configDir = await tempDir()
  await saveConfig({ ...LOGGED_IN, defaultChat: '@old' }, configDir)
  const out = collect()

  await runStatus({ to: '@new' }, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.equal((await loadConfig(configDir)).defaultChat, '@new')
  assert.match(out.text(), /Destination\s+https:\/\/web\.telegram\.org\/k\/#@new/)
  assert.doesNotMatch(out.text(), /@old/)
})

test('status --to with an unusable destination writes nothing', async () => {
  const configDir = await tempDir()
  await saveConfig({ ...LOGGED_IN, defaultChat: '@old' }, configDir)

  await assert.rejects(
    () => runStatus({ to: '  ' }, {
      configDir,
      log: () => {},
      connect: async () => fakeClient(),
      disconnect: async () => {},
    }),
    /must not be empty/,
  )

  assert.equal((await loadConfig(configDir)).defaultChat, '@old')
})

test('the destination is shown as a link that can be clicked', async () => {
  const configDir = await tempDir()
  await saveConfig({ ...LOGGED_IN, defaultChat: '-5107543795' }, configDir)
  await saveState('aaa', {
    id: 'ark-1',
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
  const configDir = await tempDir()
  await saveConfig({ ...LOGGED_IN, defaultChat: 'me' }, configDir)
  const out = collect()

  await runStatus({}, {
    configDir,
    log: out.log,
    connect: async () => fakeClient(),
    disconnect: async () => {},
  })

  assert.match(out.text(), /Destination\s+me \(Saved Messages\)/)
})
