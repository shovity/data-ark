import test from 'node:test'
import assert from 'node:assert/strict'

import { withRetry } from '../src/retry.js'

function fakeSleep(log) {
  return async (ms) => {
    log.push(ms)
  }
}

test('thành công ngay lần đầu thì không chờ', async () => {
  const delays = []
  const result = await withRetry(async () => 'xong', { sleep: fakeSleep(delays) })

  assert.equal(result, 'xong')
  assert.deepEqual(delays, [])
})

test('thử lại cho tới khi thành công', async () => {
  const delays = []
  let calls = 0

  const result = await withRetry(
    async () => {
      calls += 1
      if (calls < 3) throw new Error('mạng lỗi')
      return 'xong'
    },
    { baseDelayMs: 100, sleep: fakeSleep(delays) },
  )

  assert.equal(result, 'xong')
  assert.equal(calls, 3)
  assert.deepEqual(delays, [100, 200])
})

test('backoff lũy thừa cho tới lần cuối', async () => {
  const delays = []

  await assert.rejects(
    () => withRetry(async () => { throw new Error('hỏng hẳn') }, {
      attempts: 5,
      baseDelayMs: 100,
      sleep: fakeSleep(delays),
    }),
    /hỏng hẳn/,
  )

  assert.deepEqual(delays, [100, 200, 400, 800])
})

test('mặc định thử tối đa 5 lần', async () => {
  let calls = 0
  const delays = []

  await assert.rejects(
    () => withRetry(async () => { calls += 1; throw new Error('hỏng') }, { sleep: fakeSleep(delays), baseDelayMs: 1 }),
    /hỏng/,
  )

  assert.equal(calls, 5)
})

test('FLOOD_WAIT được tôn trọng đúng số giây máy chủ yêu cầu', async () => {
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
      return 'xong'
    },
    { baseDelayMs: 100, sleep: fakeSleep(delays) },
  )

  assert.deepEqual(delays, [42000])
})

test('onRetry được gọi kèm lần thử và thời gian chờ', async () => {
  const events = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls < 2) throw new Error('mạng lỗi')
      return 'xong'
    },
    {
      baseDelayMs: 100,
      sleep: async () => {},
      onRetry: (err, attempt, delayMs) => events.push([err.message, attempt, delayMs]),
    },
  )

  assert.deepEqual(events, [['mạng lỗi', 1, 100]])
})
