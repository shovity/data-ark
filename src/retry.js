const DEFAULT_ATTEMPTS = 5
const DEFAULT_BASE_DELAY_MS = 1000

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
      const delayMs = flood === null ? baseDelayMs * 2 ** (attempt - 1) : flood * 1000

      onRetry?.(err, attempt, delayMs)
      await sleep(delayMs)
    }
  }

  throw lastError
}
