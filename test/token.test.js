import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TOKEN_PREFIX_PLAIN,
  TOKEN_PREFIX_SEALED,
  decodeToken,
  encodeToken,
  isSealedToken,
} from '../src/token.js'

const ACCOUNT = {
  apiId: 123456,
  apiHash: '0123456789abcdef0123456789abcdef',
  session: '1BQANOTEuMTA4LjU2LjEyOAG7',
  settings: { chat: '@my_backups', chunkSize: 524288000 },
}

// --- the two formats, and the round trip through each ---

test('a sealed token comes back as the account it was made from', async () => {
  const token = await encodeToken(ACCOUNT, 'correct horse battery staple')

  assert.deepEqual(await decodeToken(token, 'correct horse battery staple'), ACCOUNT)
})

test('an empty passphrase makes a token that says it is not protected', async () => {
  const token = await encodeToken(ACCOUNT, '')

  assert.ok(token.startsWith(TOKEN_PREFIX_PLAIN))
  assert.equal(isSealedToken(token), false)
  assert.deepEqual(await decodeToken(token, ''), ACCOUNT)
})

test('a passphrase makes a token that says it is protected', async () => {
  const token = await encodeToken(ACCOUNT, 'a passphrase')

  assert.ok(token.startsWith(TOKEN_PREFIX_SEALED))
  assert.equal(isSealedToken(token), true)
})

test('a token is one line of base64url behind its prefix', async () => {
  const token = await encodeToken(ACCOUNT, 'a passphrase')

  assert.match(token, /^tls1\.[A-Za-z0-9_-]+$/)
})

// Whoever "simplifies" randomBytes into a constant reuses a nonce under one key, which is
// the failure that hands an attacker the keystream. Two tokens made the same way have to
// differ, and this is the test that says so out loud.
test('two tokens made from the same account and passphrase are different', async () => {
  const first = await encodeToken(ACCOUNT, 'a passphrase')
  const second = await encodeToken(ACCOUNT, 'a passphrase')

  assert.notEqual(first, second)
  assert.deepEqual(await decodeToken(second, 'a passphrase'), ACCOUNT)
})

// macOS and Linux spell the same accented passphrase with different bytes, and a key derived
// from the other spelling is simply a different key — which would reach the user as "wrong
// passphrase" for a passphrase that is right.
test('a passphrase with an accent opens a token made with the other spelling of it', async () => {
  const token = await encodeToken(ACCOUNT, 'mật khẩu'.normalize('NFC'))

  assert.deepEqual(await decodeToken(token, 'mật khẩu'.normalize('NFD')), ACCOUNT)
})

// --- damage on the way here, told apart from a wrong passphrase where that is possible ---

test('a wrong passphrase names both things it could have been', async () => {
  const token = await encodeToken(ACCOUNT, 'the right one')

  await assert.rejects(() => decodeToken(token, 'the wrong one'), (err) => {
    assert.match(err.message, /passphrase is wrong/)
    assert.match(err.message, /altered/)
    assert.match(err.message, /will not guess/)
    return true
  })
})

test('a token with one character changed is refused', async () => {
  const token = await encodeToken(ACCOUNT, 'a passphrase')
  const at = TOKEN_PREFIX_SEALED.length + 20
  const swapped = token[at] === 'A' ? 'B' : 'A'
  const altered = token.slice(0, at) + swapped + token.slice(at + 1)

  await assert.rejects(() => decodeToken(altered, 'a passphrase'), /Could not open/)
})

// Buffer.from silently drops every character outside the alphabet, so a mangled token decodes
// to *something* and then fails authentication — which would be reported as a wrong
// passphrase. This is the test that pins the re-encode comparison preventing that.
test('characters that do not belong to base64url are reported as damage, not as a wrong passphrase', async () => {
  await assert.rejects(() => decodeToken('tls1.abc!!!def', 'a passphrase'), (err) => {
    assert.match(err.message, /do not belong/)
    assert.doesNotMatch(err.message, /passphrase is wrong/)
    return true
  })
})

test('a token too short to hold a salt, a nonce and a tag says so rather than failing to decrypt', async () => {
  await assert.rejects(() => decodeToken('tls1.AAAA', 'a passphrase'), (err) => {
    assert.match(err.message, /too short/)
    assert.doesNotMatch(err.message, /passphrase is wrong/)
    return true
  })
})

test('a token in a format this telstore does not know is refused by name', async () => {
  await assert.rejects(() => decodeToken('tls9.AAAA', 'a passphrase'), (err) => {
    assert.match(err.message, /tls9/)
    assert.match(err.message, /Upgrade telstore/)
    return true
  })
})

test('something that is not a token says what one looks like', async () => {
  await assert.rejects(() => decodeToken('hello there', ''), /starts with "tls1\." or "tls0\."/)
})

// A chat client or a mail reader wrapping the line is the likeliest thing to happen to a
// token, and putting it back together cannot produce a *different* valid token because the
// authentication tag still has to match. Every other kind of damage is refused instead.
test('a token that was line-wrapped in transit still opens', async () => {
  const token = await encodeToken(ACCOUNT, 'a passphrase')
  const wrapped = `${token.slice(0, 40)}\n  ${token.slice(40)}\n`

  assert.deepEqual(await decodeToken(wrapped, 'a passphrase'), ACCOUNT)
})

test('a sealed token opened without a passphrase asks for one instead of failing to decrypt', async () => {
  const token = await encodeToken(ACCOUNT, 'a passphrase')

  await assert.rejects(() => decodeToken(token, ''), /protected by a passphrase/)
})

// --- a token is untrusted input, in the same category as a manifest ---

test('a bundle with no session is refused before it is encrypted', async () => {
  await assert.rejects(() => encodeToken({ ...ACCOUNT, session: undefined }, 'x'), /missing its session/)
})

test('a bundle with no apiHash is refused before it is encrypted', async () => {
  await assert.rejects(() => encodeToken({ ...ACCOUNT, apiHash: '' }, 'x'), /missing its apiHash/)
})

test('a bundle whose apiId is a string is refused', async () => {
  await assert.rejects(() => encodeToken({ ...ACCOUNT, apiId: '123456' }, 'x'), /api_id/)
})

test('a bundle whose apiId is fractional is refused', async () => {
  await assert.rejects(() => encodeToken({ ...ACCOUNT, apiId: 42.5 }, 'x'), /api_id/)
})

test('a bundle whose settings are a list is refused', async () => {
  await assert.rejects(() => encodeToken({ ...ACCOUNT, settings: [] }, 'x'), /"settings" in the session token/)
})

// The unprotected format carries no authentication tag at all, so what it holds has to be
// checked on arrival for the same reason a manifest is: nothing about the transport promised
// that it is what telstore wrote.
test('an unprotected token holding something that is not an account is refused', async () => {
  const forged = TOKEN_PREFIX_PLAIN + Buffer.from('{"apiId":"nope"}', 'utf8').toString('base64url')

  await assert.rejects(() => decodeToken(forged, ''), /api_id/)
})
