import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)

// A session token is this machine's Telegram login, written down so another machine can use
// it. Two formats, not one format with a flag inside: a blob that looked encrypted and was
// not would be telstore lying about what it handed over, and the prefix is the one part a
// reader can check before knowing anything else about the bytes.
export const TOKEN_PREFIX_SEALED = 'tls1.'
export const TOKEN_PREFIX_PLAIN = 'tls0.'

const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const OVERHEAD = SALT_BYTES + IV_BYTES + TAG_BYTES

// Pinned to the prefix above, never carried inside the token. Whoever holds a token can try
// passphrases offline as fast as their hardware allows, and 64MB per attempt is what makes
// that expensive; letting a token name its own parameters would let a stranger's N decide how
// much memory this machine allocates, which is a denial of service that needs no passphrase
// at all. maxmem is spelled out because Node's own default is 32MB and would refuse these
// outright, as an error that reads like a bug in telstore.
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

const MAKE_ONE = 'Make a new one with "npx telstore token" on the machine you are logged in on.'

// Whitespace is the one damage repaired rather than refused: a chat client or a mail reader
// wrapping the line is the likeliest thing to happen to a token, whitespace is never part of
// one, and joining it back up cannot produce a *different* valid token, because the
// authentication tag still has to match. Anything else is refused — repairing it would be
// guessing at what somebody meant.
function tidy(token) {
  return String(token).replace(/\s+/g, '')
}

export function isSealedToken(text) {
  return tidy(text).startsWith(TOKEN_PREFIX_SEALED)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// A token is untrusted input in the same category as a manifest or a state file. Opening one
// proves whoever made it knew the passphrase, not that they made it correctly — and the
// unprotected format proves nothing at all. An apiId of undefined does not throw here; it
// reaches GramJS and fails much later as something that reads like a network problem.
export function checkTokenBundle(bundle) {
  if (!isPlainObject(bundle)) {
    throw new Error(
      `The session token holds ${Array.isArray(bundle) ? 'a list' : typeof bundle}, ` +
        `not an account. ${MAKE_ONE}`,
    )
  }

  if (!Number.isSafeInteger(bundle.apiId) || bundle.apiId < 1) {
    throw new Error(
      `The session token gives ${JSON.stringify(bundle.apiId)} as the api_id, which is not ` +
        `one. ${MAKE_ONE}`,
    )
  }

  for (const field of ['apiHash', 'session']) {
    if (typeof bundle[field] !== 'string' || bundle[field] === '') {
      throw new Error(`The session token is missing its ${field}. ${MAKE_ONE}`)
    }
  }

  // The twin of checkConfigShape, refused for the twin's reason: every lookup below a
  // settings that is not an object returns undefined, and telstore would then run on its
  // built-in defaults while the choices carried in the token sat there ignored.
  if (bundle.settings !== undefined && !isPlainObject(bundle.settings)) {
    throw new Error(
      `"settings" in the session token holds ` +
        `${Array.isArray(bundle.settings) ? 'a list' : typeof bundle.settings}, not a group ` +
        `of settings. ${MAKE_ONE}`,
    )
  }

  return bundle
}

// Both spellings of the same accented passphrase have to derive the same key: macOS hands
// back one and Linux the other, and the difference would surface as "wrong passphrase" for a
// passphrase that is right.
function keyFrom(passphrase, salt) {
  return derive(String(passphrase).normalize('NFC'), salt, KEY_BYTES, SCRYPT)
}

export async function encodeToken(bundle, passphrase) {
  checkTokenBundle(bundle)

  const json = JSON.stringify(bundle)

  // An empty passphrase is not a weak secret, it is the absence of one. Saying so in the
  // prefix is what keeps the format honest: the alternative is a token that opens for anyone
  // who reads the channel it travelled through while looking exactly like a protected one.
  if (String(passphrase) === '') {
    return TOKEN_PREFIX_PLAIN + Buffer.from(json, 'utf8').toString('base64url')
  }

  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', await keyFrom(passphrase, salt), iv)
  const body = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])

  return (
    TOKEN_PREFIX_SEALED +
    Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString('base64url')
  )
}

function splitToken(token) {
  const text = tidy(token)

  for (const prefix of [TOKEN_PREFIX_SEALED, TOKEN_PREFIX_PLAIN]) {
    if (text.startsWith(prefix)) return { sealed: prefix === TOKEN_PREFIX_SEALED, encoded: text.slice(prefix.length) }
  }

  const version = /^([a-z]+\d+)\./.exec(text)

  if (version) {
    throw new Error(
      `This session token is in format "${version[1]}", which this telstore does not know ` +
        `(it reads "${TOKEN_PREFIX_SEALED.slice(0, -1)}" and ` +
        `"${TOKEN_PREFIX_PLAIN.slice(0, -1)}"). Upgrade telstore, or make a new token with ` +
        'the version you have.',
    )
  }

  throw new Error(
    `That does not look like a session token: one starts with "${TOKEN_PREFIX_SEALED}" or ` +
      `"${TOKEN_PREFIX_PLAIN}". ${MAKE_ONE}`,
  )
}

function bodyBytes(encoded) {
  const trimmed = encoded.replace(/=+$/, '')
  const bytes = Buffer.from(trimmed, 'base64url')

  // Buffer.from silently drops every character outside the alphabet, so a token with a stray
  // quote in it decodes to *something* — which would then fail authentication and be
  // reported as a wrong passphrase. Re-encoding and comparing is what turns that into the
  // sentence that actually helps.
  if (bytes.toString('base64url') !== trimmed) {
    throw new Error(
      'The session token has characters that do not belong to one — it was probably ' +
        'truncated or altered on the way here. Copy it again, whole.',
    )
  }

  return bytes
}

export async function decodeToken(token, passphrase) {
  const { sealed, encoded } = splitToken(token)
  const bytes = bodyBytes(encoded)

  if (!sealed) {
    return checkTokenBundle(readJson(bytes.toString('utf8')))
  }

  // Asked here rather than at the top: a token nobody can read is a different problem from a
  // passphrase nobody supplied, and telling someone to type a passphrase for a token that was
  // damaged in transit sends them after the wrong thing.
  if (String(passphrase) === '') {
    throw new Error(
      'This session token is protected by a passphrase, and none was given. Run the command ' +
        'again where you can type it.',
    )
  }

  if (bytes.length <= OVERHEAD) {
    throw new Error(
      `The session token is too short to be one: it carries ${bytes.length} bytes and the ` +
        `salt, nonce and tag alone need ${OVERHEAD}. Copy it again, whole.`,
    )
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    await keyFrom(passphrase, bytes.subarray(0, SALT_BYTES)),
    bytes.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES),
  )

  decipher.setAuthTag(bytes.subarray(SALT_BYTES + IV_BYTES, OVERHEAD))

  let json
  try {
    json = Buffer.concat([
      decipher.update(bytes.subarray(OVERHEAD)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // AES-GCM cannot tell a wrong key from altered bytes: both are one failed tag check, and
    // guessing which it was would send half the readers after the wrong thing. Name both, put
    // the likelier one first, and say out loud that telstore is not guessing.
    throw new Error(
      'Could not open the session token: either the passphrase is wrong or the token was ' +
        'altered on the way here. Encryption cannot tell those two apart, so telstore will ' +
        'not guess — check the passphrase first, then copy the token again, whole.',
    )
  }

  return checkTokenBundle(readJson(json))
}

// Past the tag check the plaintext is ours, so bad JSON here is not somebody else's mistake:
// it means the token was written by a telstore that disagreed with this one about the format.
function readJson(json) {
  try {
    return JSON.parse(json)
  } catch (err) {
    throw new Error(
      `The session token opened, but what is inside it is not what telstore writes ` +
        `(${err.message}). ${MAKE_ONE}`,
    )
  }
}
