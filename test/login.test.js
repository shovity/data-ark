import test from 'node:test'
import assert from 'node:assert/strict'

import { describeLoginError } from '../src/commands/login.js'

test('describeLoginError dịch mã lỗi số điện thoại không hợp lệ', () => {
  assert.equal(
    describeLoginError({ message: 'PHONE_NUMBER_INVALID' }),
    'số điện thoại không hợp lệ (PHONE_NUMBER_INVALID)',
  )
})

test('describeLoginError dịch mã lỗi mã xác nhận sai', () => {
  assert.equal(describeLoginError({ message: 'PHONE_CODE_INVALID' }), 'mã xác nhận sai (PHONE_CODE_INVALID)')
})

test('describeLoginError dịch mã lỗi mã xác nhận hết hạn', () => {
  assert.equal(describeLoginError({ message: 'PHONE_CODE_EXPIRED' }), 'mã xác nhận đã hết hạn (PHONE_CODE_EXPIRED)')
})

test('describeLoginError dịch mã lỗi mật khẩu hai lớp sai', () => {
  assert.equal(describeLoginError({ message: 'PASSWORD_HASH_INVALID' }), 'mật khẩu hai lớp sai (PASSWORD_HASH_INVALID)')
})

test('describeLoginError dịch mã lỗi giới hạn tần suất kèm số giây', () => {
  assert.equal(
    describeLoginError({ message: 'FLOOD_WAIT_30' }),
    'bị Telegram giới hạn tần suất, cần chờ (FLOOD_WAIT_30)',
  )
})

test('describeLoginError giữ nguyên văn bản gốc khi không nhận diện được mã lỗi', () => {
  assert.equal(describeLoginError({ message: 'SOME_UNKNOWN_ERROR' }), 'SOME_UNKNOWN_ERROR')
})
