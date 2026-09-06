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

test('--help prints the help and exits 0', async () => {
  const { code, stdout } = await runCli(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /npx data-ark restore/)
})

test('no arguments prints the help too', async () => {
  const { code, stdout } = await runCli([])
  assert.equal(code, 0)
  assert.match(stdout, /Usage/)
})

test('an unknown flag exits 2 with the help', async () => {
  const { code, stderr } = await runCli(['data.tar', '--made-up'])
  assert.equal(code, 2)
  assert.match(stderr, /--made-up/)
  assert.match(stderr, /Usage/)
})

test('restore without a backup id gives an example, not a stack trace', async () => {
  const { code, stderr } = await runCli(['restore'])
  assert.equal(code, 1)
  assert.match(stderr, /Missing backup id/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})

test('uploading a nonexistent file gives a short error, not a stack trace', async () => {
  const { code, stderr } = await runCli(['/does/not/exist/at/all.tar'])
  assert.equal(code, 1)
  assert.match(stderr, /Error:/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})

test(
  'SIGINT during login: exits 130 without claiming anything false about progress',
  { timeout: 10_000 },
  async () => {
    // HOME points at an isolated temp directory so login never touches the real ~/.data-ark.
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
          reject(new Error(`No api_id prompt appeared in time. stdout so far: ${JSON.stringify(stdout)}`))
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
      assert.equal(stderr, '\nStopped.\n')
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  },
)

test('list without a login gives a short error, not a stack trace', async () => {
  // HOME points at an isolated temp directory so this never reads the real ~/.data-ark.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-list-bin-'))

  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, 'list'], {
      env: { ...process.env, HOME: home },
    }).catch((err) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' }))

    assert.match(stderr, /Not logged in/)
    assert.doesNotMatch(stderr, /at .*\.js:\d+/)
    assert.equal(stdout, '')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// config is the one command whose entire job is a file write, and every unit test injects
// configDir. This is the only place the real path, the real argv and the real exit codes
// are exercised together.
test('config writes a setting and reads it back through the real argv', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-config-bin-'))

  try {
    const env = { ...process.env, HOME: home }

    const set = await run(process.execPath, [BIN, 'config', 'chat', '-1001234567890'], { env })
    assert.match(set.stdout, /chat = -1001234567890/)

    const get = await run(process.execPath, [BIN, 'config', 'chat'], { env })
    assert.equal(get.stdout.trim(), '-1001234567890')

    const list = await run(process.execPath, [BIN, 'config'], { env })
    assert.match(list.stdout, /concurrency\s+8\s+\(default\)/)

    const stored = JSON.parse(await fs.readFile(path.join(home, '.data-ark', 'config.json'), 'utf8'))
    assert.deepEqual(stored, { settings: { chat: -1001234567890 } })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('--to with nothing to upload names the command that saves a destination', async () => {
  const { code, stderr } = await runCli(['--to', '@my_backups'])

  assert.equal(code, 2)
  assert.match(stderr, /data-ark config chat @my_backups/)
  assert.doesNotMatch(stderr, /at .*\.js:\d+/)
})
