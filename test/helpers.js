import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A config that passes assertLoggedIn. Tests that only need to get past the login gate
// say LOGGED_IN rather than restating what a valid session happens to look like.
export const LOGGED_IN = { session: 's', apiId: 1, apiHash: 'h' }

// Every temp directory a test asks for is removed when the process leaves, which is the one
// moment that arrives whether the test passed, failed or threw on the line before its own
// cleanup. Each test file is its own process under `node --test`, so this runs per file.
const created = []

process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

export async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `telstore-${prefix}-`))
  created.push(dir)
  return dir
}

// Commands narrate through an injected log, so a test reads what the user would have seen.
export function collect() {
  const lines = []

  return {
    lines,
    log: (line) => lines.push(line),
    text: () => lines.join('\n'),
  }
}
