import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeChatTarget, requireChat } from '../src/client.js'

test('me giữ nguyên', () => {
  assert.equal(normalizeChatTarget('me'), 'me')
})

test('username giữ nguyên dạng chuỗi', () => {
  assert.equal(normalizeChatTarget('@kho_backup'), '@kho_backup')
})

test('id kênh chuyển thành số', () => {
  assert.equal(normalizeChatTarget('-1001234567890'), -1001234567890)
  assert.equal(normalizeChatTarget('123456'), 123456)
})

test('khoảng trắng thừa bị cắt', () => {
  assert.equal(normalizeChatTarget('  @kho  '), '@kho')
})

test('chuỗi rỗng bị từ chối', () => {
  assert.throws(() => normalizeChatTarget('   '), /rỗng/)
})

test('requireChat ưu tiên --to hơn cấu hình', () => {
  assert.equal(requireChat({ to: '@moi' }, { defaultChat: '@cu' }), '@moi')
})

test('requireChat dùng đích đã ghi nhớ khi không có --to', () => {
  assert.equal(requireChat({}, { defaultChat: '@cu' }), '@cu')
})

test('requireChat hướng dẫn khi chưa từng có đích nào', () => {
  assert.throws(() => requireChat({}, {}), /--to/)
})
