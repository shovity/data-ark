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

test('các hằng số khớp giới hạn MTProto', () => {
  assert.equal(PART_SIZE, 524288)
  assert.equal(MAX_PARTS, 4000)
  assert.equal(MAX_CHUNK_SIZE, 1950 * 1024 * 1024)
  assert.equal(DEFAULT_CHUNK_SIZE, 1800 * 1024 * 1024)
})

test('parseSize hiểu các đơn vị', () => {
  assert.equal(parseSize('1800MB'), 1887436800)
  assert.equal(parseSize('1.8GB'), Math.floor(1.8 * 1024 ** 3))
  assert.equal(parseSize('512KB'), 524288)
  assert.equal(parseSize('1024'), 1024)
  assert.equal(parseSize(2048), 2048)
})

test('parseSize không phân biệt hoa thường và bỏ qua khoảng trắng', () => {
  assert.equal(parseSize('  10 mb '), 10 * 1024 * 1024)
  assert.equal(parseSize('10Mb'), 10 * 1024 * 1024)
})

test('parseSize từ chối chuỗi vô nghĩa', () => {
  assert.throws(() => parseSize('to đùng'), /không hợp lệ/)
  assert.throws(() => parseSize('10TB'), /không hợp lệ/)
})

test('parseSize từ chối giá trị không dương', () => {
  assert.throws(() => parseSize('0'), /lớn hơn 0/)
})

test('parseSize từ chối chunk vượt trần MTProto và giải thích lý do', () => {
  assert.throws(() => parseSize('2GB'), /4000 phần/)
  assert.throws(() => parseSize('1951MB'), /1950MB/)
})

test('parseSize chấp nhận đúng biên trên', () => {
  assert.equal(parseSize('1950MB'), MAX_CHUNK_SIZE)
})

test('planChunks: file nhỏ hơn một chunk cho đúng một chunk', () => {
  assert.deepEqual(planChunks(5, 10), [{ i: 0, offset: 0, length: 5 }])
})

test('planChunks: file chia hết chằn chặn không sinh chunk rỗng ở cuối', () => {
  assert.deepEqual(planChunks(20, 10), [
    { i: 0, offset: 0, length: 10 },
    { i: 1, offset: 10, length: 10 },
  ])
})

test('planChunks: dư đúng 1 byte thì chunk cuối dài 1', () => {
  assert.deepEqual(planChunks(21, 10), [
    { i: 0, offset: 0, length: 10 },
    { i: 1, offset: 10, length: 10 },
    { i: 2, offset: 20, length: 1 },
  ])
})

test('planChunks: file đúng bằng một chunk', () => {
  assert.deepEqual(planChunks(10, 10), [{ i: 0, offset: 0, length: 10 }])
})

test('planChunks từ chối file rỗng', () => {
  assert.throws(() => planChunks(0, 10), /rỗng/)
})
