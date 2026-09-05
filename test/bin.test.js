import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
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

test(
  'SIGINT khi đang login: thoát 130, không tuyên bố sai về tiến độ',
  { timeout: 10_000 },
  async () => {
    // HOME trỏ vào thư mục tạm cô lập để login không bao giờ chạm tới ~/.data-ark thật.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-sigint-'))

    try {
      const child = spawn(process.execPath, [BIN, 'login'], {
        env: { ...process.env, HOME: home },
      })

      let stdout = ''
      let stderr = ''

      const { code } = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`Không thấy prompt api_id sau khi chờ. stdout hiện có: ${JSON.stringify(stdout)}`))
        }, 5000)

        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString()
          if (/api_id/.test(stdout)) {
            child.kill('SIGINT')
          }
        })

        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString()
        })

        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })

        child.on('exit', (exitCode) => {
          clearTimeout(timer)
          resolve({ code: exitCode })
        })
      })

      assert.equal(code, 130)
      assert.equal(stderr, '\nĐã dừng.\n')
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  },
)
