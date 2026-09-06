import test from 'node:test'
import assert from 'node:assert/strict'

import { unlockConfig } from '../src/session.js'
import { encodeToken } from '../src/token.js'

const ACCOUNT = { apiId: 123456, apiHash: '0123456789abcdef', session: '1BQANOTEu' }

// A readSecret that fails the test if it is ever reached. A machine logged in the ordinary
// way must never be asked for a passphrase it was never given.
const neverAsk = () => {
  throw new Error('asked for a passphrase it did not need')
}

test('a config logged in the ordinary way gives up its credentials without asking anything', async () => {
  const config = { ...ACCOUNT, settings: { chat: 'me' } }

  assert.deepEqual(await unlockConfig(config, { readSecret: neverAsk }), ACCOUNT)
})

test('a sealed config asks for the passphrase once and returns what the token holds', async () => {
  const asked = []
  const config = { sealed: await encodeToken(ACCOUNT, 'a passphrase') }

  const opened = await unlockConfig(config, {
    readSecret: (question) => {
      asked.push(question)
      return 'a passphrase'
    },
  })

  assert.equal(opened.session, ACCOUNT.session)
  assert.equal(opened.apiId, ACCOUNT.apiId)
  assert.equal(asked.length, 1)
  assert.match(asked[0], /[Pp]assphrase/)
})

test('a wrong passphrase fails with the token\'s own words, not a config file\'s', async () => {
  const config = { sealed: await encodeToken(ACCOUNT, 'a passphrase') }

  await assert.rejects(
    () => unlockConfig(config, { readSecret: () => 'the wrong one' }),
    /Could not open the session token/,
  )
})

// The sealed blob is the whole account, so nothing outside it may be believed: a settings
// block edited on the far machine must not be able to change which account is used.
test('a sealed config takes its account from the token and not from around it', async () => {
  const config = { sealed: await encodeToken(ACCOUNT, 'p'), apiId: 999, session: 'forged' }

  const opened = await unlockConfig(config, { readSecret: () => 'p' })

  assert.equal(opened.apiId, ACCOUNT.apiId)
  assert.equal(opened.session, ACCOUNT.session)
})
