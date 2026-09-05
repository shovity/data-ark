const DEFAULT_ATTEMPTS = 8
const DEFAULT_BASE_DELAY_MS = 1000

// Past half a minute the doubling stops buying anything: the wait is already long enough
// that the far side has either recovered or is not coming back on this attempt. Left
// uncapped, eight attempts would end in a two-minute stare at a frozen bar.
const MAX_BACKOFF_MS = 30_000

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function floodWaitSeconds(err) {
  if (typeof err?.seconds === 'number' && String(err?.errorMessage ?? '').includes('FLOOD_WAIT')) {
    return err.seconds
  }
  return null
}

export async function withRetry(fn, options = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    sleep = defaultSleep,
    onRetry,
  } = options

  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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

      onRetry?.(err, attempt, delayMs)
      await sleep(delayMs)
    }
  }

  throw lastError
}
