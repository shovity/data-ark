// Sixty seconds of silence on one 512KB part is a dead connection, not a slow one: a link
// that cannot deliver 8KB/s could not finish a multi-gigabyte restore anyway.
export const DEFAULT_STALL_MS = 60_000

// A request that never comes back is not the same as one that fails, and only one of the
// two is something withRetry can do anything about.
//
// GramJS can leave a request queued on a sender it has quietly given up on. Its own abort
// path is unreachable: MTProtoSender rejects pending states only when
// `_currentRetries > _reconnectRetries`, and `reconnectRetries` has no default to compare
// against, so the test is never true (network/MTProtoSender.js:376). Nor does the reconnect
// itself report failure — `connect()` exhausts its attempts and returns false rather than
// throwing, so `_reconnect()` finishes as if it had worked and puts the request back on a
// queue with no send loop left to drain it (network/MTProtoSender.js:148,795).
//
// The promise then simply sits there. Nothing throws, nothing prints, and once no handle is
// left the process ends mid-transfer without a word — the one outcome this project forbids.
export async function withStallTimeout(promise, ms, describe) {
  if (!(ms > 0)) return await promise

  let timer

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        // Deliberately not unref'd. This timer is the only thing keeping the event loop
        // alive while a request is outstanding, so a stall ends in this rejection instead
        // of in Node running out of work and exiting silently.
        timer = setTimeout(() => reject(new Error(describe())), ms)
      }),
    ])
  } finally {
    // Promise.race has already attached a handler to `promise`, so a rejection arriving
    // after we have stopped waiting is still handled and cannot surface as an
    // unhandledRejection that hides the stall.
    clearTimeout(timer)
  }
}
