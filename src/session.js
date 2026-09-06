import { readSecret as realReadSecret } from './prompt.js'
import { decodeToken } from './token.js'

// How a stored config becomes the three things teleproto needs. There are two shapes on disk —
// the ordinary login, and the sealed blob `login --token` writes — and this is the one place
// that knows the difference, so `connect` stays about Telegram and the commands stay about
// their own narrative.
export async function unlockConfig(config, { readSecret = realReadSecret } = {}) {
  const { sealed } = config

  if (!sealed) {
    const { apiId, apiHash, session } = config

    return { apiId, apiHash, session }
  }

  const passphrase = await readSecret('Passphrase for the stored session: ')
  // Everything comes out of the blob and nothing from around it. The fields beside it on disk
  // are editable by anyone who can reach the file, and an apiId taken from there would let an
  // edit decide which account a passphrase unlocks.
  const { apiId, apiHash, session } = await decodeToken(sealed, passphrase)

  return { apiId, apiHash, session }
}

// Two shapes count as logged in: the ordinary one login writes, and the sealed blob that
// "login --token" leaves, which holds the same three fields behind a passphrase. It lives
// here rather than beside connect because knowing both shapes is this file's whole job, and
// because `token` is an offline command: reaching for it through src/client.js pulled the
// whole of teleproto into a run that never opens a socket.
export function assertLoggedIn(config) {
  if (config.sealed) return

  if (!config.session || !config.apiId || !config.apiHash) {
    throw new Error('Not logged in — run "npx telstore login" first.')
  }
}
