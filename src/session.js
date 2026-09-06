import { readSecret as realReadSecret } from './prompt.js'
import { decodeToken } from './token.js'

// How a stored config becomes the three things GramJS needs. There are two shapes on disk —
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
