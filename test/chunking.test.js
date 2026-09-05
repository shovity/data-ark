import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSize,
  planChunks,
  PART_SIZE,
  MAX_PARTS,
  MAX_CHUNK_SIZE,
  DEFAULT_CHUNK_SIZE,
} from '../src/chunking.js'

test('constants match the MTProto limits', () => {
  assert.equal(PART_SIZE, 524288)
  assert.equal(MAX_PARTS, 4000)
  assert.equal(MAX_CHUNK_SIZE, 1950 * 1024 * 1024)
  assert.equal(DEFAULT_CHUNK_SIZE, 1800 * 1024 * 1024)
})

test('parseSize understands the units', () => {
  assert.equal(parseSize('1800MB'), 1887436800)
  assert.equal(parseSize('1.8GB'), Math.floor(1.8 * 1024 ** 3))
  assert.equal(parseSize('512KB'), 524288)
  assert.equal(parseSize('1024'), 1024)
  assert.equal(parseSize(2048), 2048)
})

test('parseSize is case-insensitive and ignores whitespace', () => {
  assert.equal(parseSize('  10 mb '), 10 * 1024 * 1024)
  assert.equal(parseSize('10Mb'), 10 * 1024 * 1024)
})

test('parseSize rejects nonsense strings', () => {
  assert.throws(() => parseSize('huge'), /Invalid size/)
  assert.throws(() => parseSize('10TB'), /Invalid size/)
})

test('parseSize rejects non-positive values', () => {
  assert.throws(() => parseSize('0'), /greater than 0/)
})

test('parseSize rejects chunks above the MTProto ceiling and explains why', () => {
  assert.throws(() => parseSize('2GB'), /4000 parts/)
  assert.throws(() => parseSize('1951MB'), /1950MB/)
})

test('parseSize accepts the upper bound exactly', () => {
  assert.equal(parseSize('1950MB'), MAX_CHUNK_SIZE)
})

test('planChunks: a file smaller than one chunk yields exactly one chunk', () => {
  assert.deepEqual(planChunks(5, 10), [{ i: 0, offset: 0, length: 5 }])
})

test('planChunks: an evenly divisible file produces no empty trailing chunk', () => {
  assert.deepEqual(planChunks(20, 10), [
    { i: 0, offset: 0, length: 10 },
    { i: 1, offset: 10, length: 10 },
  ])
})

test('planChunks: a 1-byte remainder makes the last chunk 1 byte long', () => {
  assert.deepEqual(planChunks(21, 10), [
    { i: 0, offset: 0, length: 10 },
    { i: 1, offset: 10, length: 10 },
    { i: 2, offset: 20, length: 1 },
  ])
})

test('planChunks: a file exactly one chunk long', () => {
  assert.deepEqual(planChunks(10, 10), [{ i: 0, offset: 0, length: 10 }])
})

test('planChunks rejects an empty file', () => {
  assert.throws(() => planChunks(0, 10), /empty/)
})
