import test from 'node:test'
import assert from 'node:assert/strict'
import { runList } from '../src/commands/list.js'
import { manifestCaption } from '../src/caption.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { LOGGED_IN, collect, tempDir } from './helpers.js'

async function workspace(config = {}) {
  const configDir = await tempDir('list')
  await saveConfig({ ...LOGGED_IN, settings: { chat: '@store', ...config } }, configDir)
  return configDir
}

function manifestMessage({ id, name, size, chunks, createdAt, msgId = 2000 }) {
  return {
    id: msgId,
    fileName: `${id}.manifest.json`,
    caption: manifestCaption({ id, name, size, chunks, createdAt }),
    date: Math.floor(Date.parse(createdAt) / 1000),
  }
}

function deps(configDir, messages, out, extra = {}) {
  return {
    configDir,
    log: out.log,
    connect: async () => ({}),
    disconnect: async () => {},
    searchManifests: async () => messages,
    ...extra,
  }
}

const DATA_TAR = manifestMessage({
  id: 'telstore-20260905-7f3a91',
  name: 'data.tar',
  size: 22_998_546_842,
  chunks: 12,
  createdAt: '2026-09-05T16:40:12.000Z',
})

const PHOTOS = manifestMessage({
  id: 'telstore-20260901-9de447',
  name: 'photos.zip',
  size: 985_949_798,
  chunks: 1,
  createdAt: '2026-09-01T08:02:00.000Z',
  msgId: 1900,
})

test('every backup gets a row read from its summary card', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [DATA_TAR, PHOTOS], out))

  assert.match(out.text(), /BACKUP ID +FILE +SIZE +CHUNKS +CREATED/)
  assert.match(out.text(), /telstore-20260905-7f3a91 +data\.tar +21\.4 GB +12 +2026-09-05/)
  assert.match(out.text(), /telstore-20260901-9de447 +photos\.zip +940\.3 MB +1 +2026-09-01/)
})

test('the footer counts the backups and shows how to restore one', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [DATA_TAR, PHOTOS], out))

  assert.match(out.text(), /2 backups\./)
  assert.match(out.text(), /npx telstore restore <backup-id>/)
})

// A backup uploaded before the summary card existed still has to be listed. Its id and
// date can be read off the message itself; the rest is unknown and says so.
test('a manifest without a summary card is listed with what the message itself knows', async () => {
  const configDir = await workspace()
  const out = collect()
  const old = {
    id: 1800,
    fileName: 'telstore-20260820-aa11bb.manifest.json',
    caption: '#telstore telstore-20260820-aa11bb manifest',
    date: Math.floor(Date.parse('2026-08-20T09:00:00.000Z') / 1000),
  }

  await runList({}, deps(configDir, [old], out))

  assert.match(out.text(), /telstore-20260820-aa11bb +— +— +— +2026-08-20/)
})

// The search asks Telegram for a tag, and Telegram decides what comes back. A chunk that
// slips into the results must not be counted as a backup of its own.
test('messages that are not manifests are left out', async () => {
  const configDir = await workspace()
  const out = collect()
  const chunk = {
    id: 1500,
    fileName: 'telstore-20260905-7f3a91.part0003',
    caption: '📦 telstore-20260905-7f3a91 · 3/12',
    date: Math.floor(Date.parse('2026-09-05T16:00:00.000Z') / 1000),
  }

  await runList({}, deps(configDir, [chunk, DATA_TAR], out))

  assert.match(out.text(), /1 backup\./)
  assert.doesNotMatch(out.text(), /part0003/)
})

test('an empty chat says so instead of printing an empty table', async () => {
  const configDir = await workspace()
  const out = collect()

  await runList({}, deps(configDir, [], out))

  assert.match(out.text(), /No backups found in @store/)
  assert.doesNotMatch(out.text(), /BACKUP ID/)
})

// A flag applies to this run and nothing else: listing another chat must leave the
// configured destination exactly where it was.
test('--to looks somewhere else without changing the configured destination', async () => {
  const configDir = await workspace()
  const out = collect()
  let asked = null

  await runList({ to: '@other' }, deps(configDir, [], out, {
    searchManifests: async (client, chat) => {
      asked = chat
      return []
    },
  }))

  assert.equal(asked, '@other')
  assert.equal((await loadConfig(configDir)).settings.chat, '@store')
})

test('--limit caps how many messages the search asks for', async () => {
  const configDir = await workspace()
  const out = collect()
  let asked = null

  await runList({ limit: '5' }, deps(configDir, [], out, {
    searchManifests: async (client, chat, limit) => {
      asked = limit
      return []
    },
  }))

  assert.equal(asked, 5)
})

test('a --limit that is not a positive whole number is refused', async () => {
  const configDir = await workspace()
  const out = collect()

  await assert.rejects(() => runList({ limit: '0' }, deps(configDir, [], out)), /--limit/)
})

// Nothing about a destination helps someone who has not logged in yet, and list reaches
// requireChat before it ever opens a connection.
test('list before a login asks for the login, not for a destination', async () => {
  const configDir = await tempDir('list')
  const out = collect()

  await assert.rejects(
    () => runList({}, { ...deps(configDir, [], out), configDir }),
    /log in|login/i,
  )
})

test('an empty Saved Messages is named, not called "me"', async () => {
  const configDir = await workspace({ chat: 'me' })
  const out = collect()

  await runList({}, deps(configDir, [], out))

  assert.match(out.text(), /No backups found in Saved Messages/)
})

// The id is the one field that has to be right: restore looks the manifest up by it.
// The file name is telstore's own, the caption is text anyone in the chat can edit.
test('the backup id comes from the file name, not from the caption', async () => {
  const configDir = await workspace()
  const out = collect()
  const edited = {
    ...DATA_TAR,
    caption: DATA_TAR.caption.replace('telstore-20260905-7f3a91', 'telstore-tampered-000000'),
  }

  await runList({}, deps(configDir, [edited], out))

  assert.match(out.text(), /telstore-20260905-7f3a91/)
  assert.doesNotMatch(out.text(), /telstore-tampered-000000/)
})
