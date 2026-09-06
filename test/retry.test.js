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

test('FLOOD_WAIT is honoured for exactly the seconds the server asks for', async () => {
  const delays = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('A wait of 42 seconds is required (caused by upload.SaveBigFilePart)')
        err.code = 420
        err.errorMessage = 'FLOOD_WAIT_42'
        err.seconds = 42
        throw err
      }
      return 'done'
    },
    { baseDelayMs: 100, sleep: fakeSleep(delays) },
  )

  assert.deepEqual(delays, [42000])
})

test('the exponential backoff stops growing at 30 seconds', async () => {
  const delays = []

  await assert.rejects(
    () => withRetry(async () => { throw new Error('permanently broken') }, {
      attempts: 8,
      sleep: fakeSleep(delays),
    }),
    /permanently broken/,
  )

  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000])
})

test('a FLOOD_WAIT longer than the cap is still waited out in full', async () => {
  // Capping a flood wait means asking again before the server is ready, which earns a
  // longer ban. Only the exponential branch is capped.
  const delays = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('A wait of 3600 seconds is required')
        err.code = 420
        err.errorMessage = 'FLOOD_WAIT_3600'
        err.seconds = 3600
        throw err
      }
      return 'done'
    },
    { sleep: fakeSleep(delays) },
  )

  assert.deepEqual(delays, [3600000])
})

test('a stalled stretch is given 8 attempts, about 90 seconds of dead air', async () => {
  // 15 seconds was not enough to ride out a brief outage: five attempts spent 1+2+4+8.
  let calls = 0
  const delays = []

  await assert.rejects(
    () => withRetry(async () => { calls += 1; throw new Error('broken') }, { sleep: fakeSleep(delays) }),
    /broken/,
  )

  assert.equal(calls, 8)
  assert.equal(delays.reduce((a, b) => a + b, 0), 91000)
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

// Telegram answers "wait this long" with more than one error name, and every one of them
// arrives as code 420 carrying the seconds. Keying on the name instead means the exponential
// backoff asks again while the ban is still running, which earns a longer one — so the wait
// is read from the code and the seconds, not from how the message is spelled.
test('any 420 that names its seconds is waited out in full, not just FLOOD_WAIT', async () => {
  const delays = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('Slow mode is enabled (caused by messages.SendMedia)')
        err.code = 420
        err.errorMessage = 'SLOW_MODE_WAIT_30'
        err.seconds = 30
        throw err
      }
      return 'done'
    },
    { baseDelayMs: 100, sleep: fakeSleep(delays) },
  )

  assert.deepEqual(delays, [30000])
})

// A 420 with no seconds on it (a frozen account, say) has nothing to wait for. Reading a
// missing field as zero would retry instantly eight times over and report the account
// problem as a network one.
test('a 420 with no seconds falls back to the ordinary backoff', async () => {
  const delays = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('The account is frozen (caused by messages.SendMedia)')
        err.code = 420
        err.errorMessage = 'FROZEN_METHOD_INVALID'
        throw err
      }
      return 'done'
    },
    { baseDelayMs: 100, sleep: fakeSleep(delays) },
  )

  assert.deepEqual(delays, [100])
})
