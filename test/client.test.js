import test from 'node:test'
import assert from 'node:assert/strict'

import { LogLevel } from 'telegram/extensions/Logger.js'

import {
  DELETE_BATCH_SIZE,
  assertLoggedIn,
  createLogger,
  deleteMessages,
} from '../src/client.js'

test('assertLoggedIn throws on an empty config', () => {
  assert.throws(() => assertLoggedIn({}), /Not logged in/)
})

test('assertLoggedIn throws when apiHash is missing', () => {
  assert.throws(() => assertLoggedIn({ session: 's', apiId: 1 }), /Not logged in/)
})

test('assertLoggedIn does not throw on a complete config', () => {
  assert.doesNotThrow(() => assertLoggedIn({ session: 's', apiId: 1, apiHash: 'h' }))
})

test('the Telegram logger is silent unless --verbose is given', () => {
  const quiet = createLogger(false)
  assert.equal(quiet.canSend(LogLevel.INFO), false)
  assert.equal(quiet.canSend(LogLevel.WARN), false)

  const loud = createLogger(true)
  assert.equal(loud.canSend(LogLevel.INFO), true)
  assert.equal(loud.canSend(LogLevel.WARN), true)
})

// GramJS's own deleteMessages splits the ids into batches of 100 and fires every batch at
// once through Promise.all. telstore batches them itself so exactly one request is in
// flight at a time, under the same retry and stall policy as every other network wait.
function recordingClient({ failTimes = 0, failAlways = false, hang = false } = {}) {
  const batches = []
  let inFlight = 0
  let maxInFlight = 0

  return {
    batches,
    maxInFlight: () => maxInFlight,
    async deleteMessages(peer, ids, options) {
      batches.push({ peer, ids, options })
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)

      try {
        if (hang) return await new Promise(() => {})
        await new Promise((resolve) => setImmediate(resolve))
        if (failAlways || batches.length <= failTimes) throw new Error('server said no')
        return [{ ptsCount: ids.length }]
      } finally {
        inFlight -= 1
      }
    },
  }
}

const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i)

test('deleteMessages sends ids in batches of at most a hundred', async () => {
  const client = recordingClient()

  const removed = await deleteMessages(client, '@store', ids(250))

  assert.deepEqual(
    client.batches.map((b) => b.ids.length),
    [100, 100, 50],
  )
  assert.equal(removed, 250)
})

test('deleteMessages keeps one request in flight at a time', async () => {
  const client = recordingClient()

  await deleteMessages(client, '@store', ids(300))

  assert.equal(client.maxInFlight(), 1)
})

// GramJS destructures `{ revoke }` with no default of its own, so a two-argument call
// throws a TypeError before it reaches the network. revoke is passed explicitly anyway: a
// backup must go for everyone, and that intent belongs here rather than in a dependency.
test('deleteMessages asks Telegram to revoke, not just to hide locally', async () => {
  const client = recordingClient()

  await deleteMessages(client, '@store', [7])

  assert.deepEqual(client.batches[0].options, { revoke: true })
})

test('deleteMessages sends nothing at all for an empty list', async () => {
  const client = recordingClient()

  assert.equal(await deleteMessages(client, '@store', []), 0)
  assert.equal(client.batches.length, 0)
})

test('deleteMessages reports progress as each batch lands', async () => {
  const client = recordingClient()
  const seen = []

  await deleteMessages(client, '@store', ids(250), {
    onBatch: (done, total) => seen.push([done, total]),
  })

  assert.deepEqual(seen, [
    [100, 250],
    [200, 250],
    [250, 250],
  ])
})

test('deleteMessages retries a batch that failed once and carries on', async () => {
  const client = recordingClient({ failTimes: 1 })

  const removed = await deleteMessages(client, '@store', [1], {
    retryOptions: { attempts: 3, sleep: async () => {} },
  })

  assert.equal(removed, 1)
  assert.equal(client.batches.length, 2)
})

test('deleteMessages gives up loudly once the retries run out', async () => {
  const client = recordingClient({ failAlways: true })

  await assert.rejects(
    () =>
      deleteMessages(client, '@store', [1], {
        retryOptions: { attempts: 3, sleep: async () => {} },
      }),
    /server said no/,
  )
  assert.equal(client.batches.length, 3)
})

// A batch that fails takes the whole delete down with it: the batches after it are never
// sent, so nothing is removed past the point Telegram stopped cooperating.
test('deleteMessages stops at the batch that failed', async () => {
  const client = recordingClient({ failAlways: true })

  await assert.rejects(
    () =>
      deleteMessages(client, '@store', ids(250), {
        retryOptions: { attempts: 2, sleep: async () => {} },
      }),
    /server said no/,
  )

  assert.deepEqual(
    client.batches.map((b) => b.ids[0]),
    [1, 1],
  )
})

// A request left on a sender GramJS has stopped draining never settles. Without a deadline
// the delete would hold the process open forever and end without a word.
test('deleteMessages fails when Telegram stops answering instead of waiting forever', async () => {
  const client = recordingClient({ hang: true })

  await assert.rejects(
    () =>
      deleteMessages(client, '@store', ids(150), {
        stallMs: 5,
        retryOptions: { attempts: 1 },
      }),
    /nothing back for/,
  )
})

test('the batch size is the hundred Telegram accepts per request', () => {
  assert.equal(DELETE_BATCH_SIZE, 100)
})

test('assertLoggedIn accepts a config whose session is sealed behind a passphrase', () => {
  assert.doesNotThrow(() => assertLoggedIn({ sealed: 'tls1.abc' }))
})

test('assertLoggedIn still refuses a config with neither shape', () => {
  assert.throws(() => assertLoggedIn({ settings: { chat: 'me' } }), /Not logged in/)
})
