import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A config that passes assertLoggedIn. Tests that only need to get past the login gate
// say LOGGED_IN rather than restating what a valid session happens to look like.
export const LOGGED_IN = { session: 's', apiId: 1, apiHash: 'h' }

export async function tempDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `telstore-${prefix}-`))
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
