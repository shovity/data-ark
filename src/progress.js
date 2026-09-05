const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(n) {
  if (n < 1024) return `${n} B`

  let value = n
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(1)} ${UNITS[unit]}`
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '--'

  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

export function renderProgress({ done, total, elapsedMs, label, width = 24 }) {
  const ratio = total === 0 ? 1 : Math.min(done / total, 1)
  const filled = Math.round(ratio * width)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`

  const bytesPerSecond = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0
  const remaining = bytesPerSecond > 0 ? (total - done) / bytesPerSecond : Infinity

  const percent = String(Math.floor(ratio * 100)).padStart(3)
  const speed = `${formatBytes(Math.round(bytesPerSecond))}/s`

  return `${label} ${bar} ${percent}% ${formatBytes(done)}/${formatBytes(total)} ${speed} còn ${formatDuration(remaining)}`
}

export function createProgress({
  total,
  label,
  write = (line) => process.stderr.write(line),
  now = () => Date.now(),
  minIntervalMs = 200,
}) {
  const startedAt = now()
  let done = 0
  let lastDrawnAt = startedAt

  function draw(suffix) {
    write(`\r${renderProgress({ done, total, elapsedMs: now() - startedAt, label })}${suffix}`)
  }

  return {
    advance(bytes) {
      done += bytes
      if (now() - lastDrawnAt < minIntervalMs) return
      lastDrawnAt = now()
      draw('')
    },
    finish() {
      draw('\n')
    },
  }
}
