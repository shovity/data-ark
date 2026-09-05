import test from 'node:test'
import assert from 'node:assert/strict'

import { withRetry } from '../src/retry.js'

function fakeSleep(log) {
  return async (ms) => {
    log.push(ms)
  }
}

test('succeeding on the first try waits for nothing', async () => {
  const delays = []
  const result = await withRetry(async () => 'done', { sleep: fakeSleep(delays) })

  assert.equal(result, 'done')
  assert.deepEqual(delays, [])
})

test('retries until it succeeds', async () => {
  const delays = []
  let calls = 0

  const result = await withRetry(
    async () => {
      calls += 1
      if (calls < 3) throw new Error('network error')
      return 'done'
    },
    { baseDelayMs: 100, sleep: fakeSleep(delays) },
  )

  assert.equal(result, 'done')
  assert.equal(calls, 3)
  assert.deepEqual(delays, [100, 200])
})

test('exponential backoff up to the final attempt', async () => {
  const delays = []

  await assert.rejects(
    () => withRetry(async () => { throw new Error('permanently broken') }, {
      attempts: 5,
      baseDelayMs: 100,
      sleep: fakeSleep(delays),
    }),
    /permanently broken/,
  )

  assert.deepEqual(delays, [100, 200, 400, 800])
})

test('defaults to at most 5 attempts', async () => {
  let calls = 0
  const delays = []

  await assert.rejects(
    () => withRetry(async () => { calls += 1; throw new Error('broken') }, { sleep: fakeSleep(delays), baseDelayMs: 1 }),
    /broken/,
  )

  assert.equal(calls, 5)
})

test('FLOOD_WAIT is honoured for exactly the seconds the server asks for', async () => {
  const delays = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('A wait of 42 seconds is required (caused by upload.SaveBigFilePart)')
        err.seconds = 42
        err.errorMessage = 'FLOOD_WAIT'
        throw err
      }
      return 'done'
    },
    { baseDelayMs: 100, sleep: fakeSleep(delays) },
  )

  assert.deepEqual(delays, [42000])
})

test('onRetry is called with the attempt number and the delay', async () => {
  const events = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls < 2) throw new Error('network error')
      return 'done'
    },
    {
      baseDelayMs: 100,
      sleep: async () => {},
      onRetry: (err, attempt, delayMs) => events.push([err.message, attempt, delayMs]),
    },
  )

  assert.deepEqual(events, [['network error', 1, 100]])
})
