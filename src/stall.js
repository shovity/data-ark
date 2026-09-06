// Sixty seconds of silence on one 512KB part is a dead connection, not a slow one: a link
// that cannot deliver 8KB/s could not finish a multi-gigabyte restore anyway.
export const DEFAULT_STALL_MS = 60_000

// setTimeout stores its delay in a 32-bit signed integer. Node's answer to a larger one is
// to warn and fire after a single tick, so a deadline meant to be more patient becomes the
// least patient one there is.
const MAX_TIMER_MS = 2 ** 31 - 1

// A request that never comes back is not the same as one that fails, and only one of the
// two is something withRetry can do anything about.
//
// This was written for a GramJS bug that abandoned requests outright: its abort path tested
// `_currentRetries > _reconnectRetries` against a `reconnectRetries` of Infinity and so never
// fired, and `_reconnect()` read a `connect()` that merely returned false as success. A real
// network cut mid-restore froze a transfer for eleven minutes on Linux and ended it without a
// printed line on Windows. teleproto closes both halves — `connect()` throws once its attempts
// are spent, and `_reconnect()` catches that and rejects every pending request.
//
// The deadline stays because the library was never the only way to arrive here. A server that
// accepts a request and answers nothing, a socket that stays open with nothing coming down it:
// there is no failure for withRetry to see, only silence. The timer is what turns that silence
// into an error — and, deliberately not unref'd, it is also the handle that stops the event
// loop running dry and ending a transfer without a word.
export async function withStallTimeout(promise, ms, describe) {
  if (!(ms > 0)) return await promise

  if (ms > MAX_TIMER_MS) {
    throw new Error(
      `A stall deadline of ${ms}ms is out of range: a timer holds at most ${MAX_TIMER_MS}ms, ` +
        'and a larger one fires after a single tick rather than waiting.',
    )
  }

  let timer

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        // Deliberately not unref'd. This timer is the only thing keeping the event loop
        // alive while a request is outstanding, so a stall ends in this rejection instead
        // of in Node running out of work and exiting silently.
        timer = setTimeout(() => {
          // A throw inside a timer callback is an uncaught exception, which ends the process
          // rather than the request. Building the message must never be able to do that.
          let message

          try {
            message = describe()
          } catch (err) {
            message = `A network wait went past ${ms}ms, and describing it failed: ${err.message}`
          }

          reject(new Error(message))
        }, ms)
      }),
    ])
  } finally {
    // Promise.race has already attached a handler to `promise`, so a rejection arriving
    // after we have stopped waiting is still handled and cannot surface as an
    // unhandledRejection that hides the stall.
    clearTimeout(timer)
  }
}
