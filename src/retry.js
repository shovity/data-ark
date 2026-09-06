const DEFAULT_ATTEMPTS = 8
const DEFAULT_BASE_DELAY_MS = 1000

// Past half a minute the doubling stops buying anything: the wait is already long enough
// that the far side has either recovered or is not coming back on this attempt. Left
// uncapped, eight attempts would end in a two-minute stare at a frozen bar.
const MAX_BACKOFF_MS = 30_000

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Every "wait this long" answer Telegram gives arrives as code 420 with the seconds on the
// error itself — FLOOD_WAIT_n, SLOW_MODE_WAIT_n and the rest. Those two fields are what this
// reads, not how the message is spelled: under GramJS every flood error carried the literal
// errorMessage "FLOOD", so a check for "FLOOD_WAIT" in it matched nothing and each one was
// retried on the ordinary backoff — asking again inside a ban that was still running.
// A 420 with no seconds (a frozen account) has nothing to wait for and takes the backoff.
function floodWaitSeconds(err) {
  if (err?.code === 420 && typeof err.seconds === 'number') {
    return err.seconds
  }
  return null
}

export async function withRetry(fn, options = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    sleep = defaultSleep,
    now = Date.now,
    onRetry,
  } = options

  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = now()

    try {
      return await fn()
    } catch (err) {
      lastError = err

      if (attempt === attempts) break

      const flood = floodWaitSeconds(err)
      const delayMs =
        flood === null
          ? Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS)
          : flood * 1000

      // How long the failed attempt itself took. A request that errors instantly costs the
      // user nothing but a line of output; one that took a minute to give up left the
      // progress bar frozen for that minute. Only the caller can weigh the two, so it is
      // told which kind this was.
      onRetry?.(err, attempt, delayMs, now() - startedAt)
      await sleep(delayMs)
    }
  }

  throw lastError
}
