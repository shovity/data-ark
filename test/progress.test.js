import test from 'node:test'
import assert from 'node:assert/strict'

import { formatBytes, formatDuration, renderProgress, createProgress } from '../src/progress.js'

test('formatBytes picks a sensible unit', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 ** 2), '1.0 MB')
  assert.equal(formatBytes(1887436800), '1.8 GB')
  assert.equal(formatBytes(1024 ** 4), '1.0 TB')
})

test('formatDuration is human readable', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45), '45s')
  assert.equal(formatDuration(90), '1m30s')
  assert.equal(formatDuration(3661), '1h1m')
  assert.equal(formatDuration(Infinity), '--')
})

test('renderProgress shows the label, percentage, speed and ETA', () => {
  const line = renderProgress({
    done: 500 * 1024 * 1024,
    total: 1000 * 1024 * 1024,
    elapsedMs: 10_000,
    label: 'Chunk 1/3',
    width: 10,
  })

  assert.match(line, /Chunk 1\/3/)
  assert.match(line, /50%/)
  assert.match(line, /50\.0 MB\/s/)
  assert.match(line, /ETA 10s/)
})

test('renderProgress does not divide by zero before any time has passed', () => {
  const line = renderProgress({ done: 0, total: 100, elapsedMs: 0, label: 'x', width: 10 })
  assert.match(line, /0%/)
  assert.doesNotMatch(line, /NaN/)
})

test('renderProgress reports ETA 0s at 100%', () => {
  const line = renderProgress({ done: 100, total: 100, elapsedMs: 1000, label: 'x', width: 10 })
  assert.match(line, /100%/)
  assert.match(line, /ETA 0s/)
})

test('createProgress coalesces updates that arrive too close together', () => {
  const lines = []
  let clock = 0

  const progress = createProgress({
    total: 1000,
    label: 'Chunk 1/1',
    write: (line) => lines.push(line),
    now: () => clock,
    minIntervalMs: 100,
  })

  clock = 10
  progress.advance(100)
  clock = 20
  progress.advance(100)
  clock = 200
  progress.advance(100)

  assert.equal(lines.length, 1)
  assert.match(lines[0], /30%/)
})

test('finish always draws a final line and a newline', () => {
  const lines = []
  let clock = 0

  const progress = createProgress({
    total: 100,
    label: 'x',
    write: (line) => lines.push(line),
    now: () => clock,
    minIntervalMs: 1000,
  })

  progress.advance(100)
  progress.finish()

  assert.equal(lines.length, 1)
  assert.match(lines[0], /100%/)
  assert.match(lines[0], /\n$/)
})

test('renderProgress never shows a negative ETA when done overshoots total', () => {
  const line = renderProgress({ done: 1500, total: 1000, elapsedMs: 1000, label: 'x', width: 10 })
  assert.match(line, /100%/)
  assert.match(line, /ETA 0s/)
  assert.doesNotMatch(line, /ETA -/)
})
