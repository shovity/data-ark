import test from 'node:test'
import assert from 'node:assert/strict'

import { route } from '../src/cli.js'

test('tham số đầu không phải subcommand thì coi là file cần upload', () => {
  const r = route(['data.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['data.tar'])
})

test('đường dẫn có dấu gạch vẫn là upload', () => {
  const r = route(['./sao-luu/data.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['./sao-luu/data.tar'])
})

test('restore được nhận là subcommand kèm backup id', () => {
  const r = route(['restore', 'ark-20260905-7f3a91'])
  assert.equal(r.command, 'restore')
  assert.deepEqual(r.args, ['ark-20260905-7f3a91'])
})

test('login và logout là subcommand', () => {
  assert.equal(route(['login']).command, 'login')
  assert.equal(route(['logout']).command, 'logout')
})

test('không có tham số thì hiện trợ giúp', () => {
  assert.equal(route([]).command, 'help')
})

test('đọc được các cờ đi kèm', () => {
  const r = route(['data.tar', '--to', '@kho_backup', '--chunk-size', '1.8GB', '--concurrency', '4'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['data.tar'])
  assert.equal(r.options.to, '@kho_backup')
  assert.equal(r.options['chunk-size'], '1.8GB')
  assert.equal(r.options.concurrency, '4')
})

test('cờ --out dành cho restore', () => {
  const r = route(['restore', 'ark-1', '--out', '/tmp/ra.tar'])
  assert.equal(r.command, 'restore')
  assert.equal(r.options.out, '/tmp/ra.tar')
})

test('cờ không hợp lệ báo lỗi rõ ràng', () => {
  assert.throws(() => route(['data.tar', '--khong-ton-tai']), /--khong-ton-tai/)
})
