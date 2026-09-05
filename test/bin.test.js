import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'data-ark.js')

async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args])
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('--help in trợ giúp và thoát 0', async () => {
  const { code, stdout } = await runCli(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /npx data-ark restore/)
})

test('không tham số cũng in trợ giúp', async () => {
  const { code, stdout } = await runCli([])
  assert.equal(code, 0)
  assert.match(stdout, /Cách dùng/)
})

test('cờ lạ thoát mã 2 kèm trợ giúp', async () => {
  const { code, stderr } = await runCli(['data.tar', '--bay-bong'])
  assert.equal(code, 2)
  assert.match(stderr, /--bay-bong/)
  assert.match(stderr, /Cách dùng/)
})

test('restore thiếu backup id báo lỗi có ví dụ, không phải stack trace', async () => {
  const { code, stderr } = await runCli(['restore'])
  assert.equal(code, 1)
  assert.match(stderr, /Thiếu backup id/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})

test('upload file không tồn tại báo lỗi gọn, không stack trace', async () => {
  const { code, stderr } = await runCli(['/khong/he/ton/tai.tar'])
  assert.equal(code, 1)
  assert.match(stderr, /Lỗi:/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})
