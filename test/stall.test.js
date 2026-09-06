import test from 'node:test'
import assert from 'node:assert/strict'

import { withStallTimeout, DEFAULT_STALL_MS } from '../src/stall.js'

test('a promise that settles in time is passed straight through', async () => {
  assert.equal(await withStallTimeout(Promise.resolve('ok'), 1000, () => 'stalled'), 'ok')
})

test('a rejection arrives as itself, not as a stall', async () => {
  await assert.rejects(
    () => withStallTimeout(Promise.reject(new Error('boom')), 1000, () => 'stalled'),
    /boom/,
  )
})

test('a promise that never settles becomes an error', async () => {
  await assert.rejects(() => withStallTimeout(new Promise(() => {}), 20, () => 'stalled'), /stalled/)
})

// setTimeout stores its delay in a 32-bit signed integer. Anything larger overflows, and
// Node's answer is to fire after 1ms — so the knob meant to make data-ark more patient made
// every single request fail instantly instead. Refuse the value rather than invert it.
test('a deadline too large for a timer is refused, not silently turned into one tick', async () => {
  await assert.rejects(
    () => withStallTimeout(new Promise(() => {}), 2 ** 31, () => 'stalled'),
    /too large|out of range/i,
  )
})

test('the default deadline fits in a timer', () => {
  assert.ok(DEFAULT_STALL_MS > 0 && DEFAULT_STALL_MS <= 2 ** 31 - 1)
})

// The message is built inside the timer callback, where a throw is an uncaught exception
// that kills the process instead of a rejection the caller can retry.
test('a description that throws still fails as a stall', async () => {
  await assert.rejects(
    () =>
      withStallTimeout(new Promise(() => {}), 20, () => {
        throw new Error('describe is broken')
      }),
    /went past 20ms/,
  )
})
