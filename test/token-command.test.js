import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { runToken } from '../src/commands/token.js'
import { decodeToken, isSealedToken } from '../src/token.js'
import { encodeToken } from '../src/token.js'
import { collect, tempDir } from './helpers.js'

const ACCOUNT = { apiId: 123456, apiHash: '0123456789abcdef', session: '1BQANOTEu' }

async function workspace(config = { ...ACCOUNT, settings: { chat: '@backups' } }) {
  const dir = await tempDir('token-command')
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config))

  return dir
}

function answers(...lines) {
  const queue = [...lines]
  const asked = []

  return {
    asked,
    prompts: {
      askSecret: (question) => {
        asked.push(question)
        if (queue.length === 0) throw new Error(`nothing left to answer: ${question}`)
        return Promise.resolve(queue.shift())
      },
      close: () => {},
    },
  }
}

function errors() {
  const written = []

  return { written, writeErr: (line) => written.push(line), text: () => written.join('') }
}

// Asking for a passphrase and only then saying "not logged in" wastes the one thing that is
// expensive for the user to produce.
test('token refuses when nobody is logged in, before asking for a passphrase', async () => {
  const dir = await tempDir('token-command')
  const prompts = answers('a passphrase', 'a passphrase')

  await assert.rejects(
    () => runToken([], {}, { configDir: dir, prompts: prompts.prompts, writeErr: () => {} }),
    /Not logged in/,
  )
  assert.deepEqual(prompts.asked, [])
})

test('token asks for the passphrase twice and refuses when the two differ', async () => {
  const dir = await workspace()
  const prompts = answers('one thing', 'another thing')

  await assert.rejects(
    () => runToken([], {}, { configDir: dir, prompts: prompts.prompts, writeErr: () => {} }),
    /two passphrases are different/,
  )
  assert.equal(prompts.asked.length, 2)
})

test('the token it prints opens with the passphrase and carries the stored settings', async () => {
  const dir = await workspace()
  const out = collect()
  const prompts = answers('correct horse battery', 'correct horse battery')

  await runToken([], {}, { configDir: dir, prompts: prompts.prompts, log: out.log, writeErr: () => {} })

  const bundle = await decodeToken(out.text(), 'correct horse battery')

  assert.equal(bundle.session, ACCOUNT.session)
  assert.equal(bundle.apiId, ACCOUNT.apiId)
  assert.deepEqual(bundle.settings, { chat: '@backups' })
})

// stdout carries exactly one thing, the same rule `config <name>` already follows, so
// "npx telstore token | qrencode" works with every warning still visible.
test('token prints the token alone on stdout and every warning on stderr', async () => {
  const dir = await workspace()
  const out = collect()
  const err = errors()
  const prompts = answers('correct horse battery', 'correct horse battery')

  await runToken([], {}, { configDir: dir, prompts: prompts.prompts, log: out.log, writeErr: err.writeErr })

  assert.equal(out.lines.length, 1)
  assert.ok(isSealedToken(out.text()))
  assert.match(err.text(), /Settings → Devices/)
  assert.doesNotMatch(err.text(), /tls1\./)
})

test('token leaves behind settings telstore does not know', async () => {
  const dir = await workspace({ ...ACCOUNT, settings: { chat: 'me', chnukSize: 5, note: 'x' } })
  const out = collect()
  const prompts = answers('a passphrase', 'a passphrase')

  await runToken([], {}, { configDir: dir, prompts: prompts.prompts, log: out.log, writeErr: () => {} })

  assert.deepEqual((await decodeToken(out.text(), 'a passphrase')).settings, { chat: 'me' })
})

// A length minimum is a preference wearing a check's clothes, and mostly teaches people to
// append digits. The warning names the attacker instead, and the token is still made.
test('token warns about a short passphrase and makes the token anyway', async () => {
  const dir = await workspace()
  const out = collect()
  const err = errors()
  const prompts = answers('short', 'short')

  await runToken([], {}, { configDir: dir, prompts: prompts.prompts, log: out.log, writeErr: err.writeErr })

  assert.ok(isSealedToken(out.text()))
  assert.match(err.text(), /offline/)
})

test('an empty passphrase makes a token that says on its face it is not protected', async () => {
  const dir = await workspace()
  const out = collect()
  const err = errors()
  const prompts = answers('', '')

  await runToken([], {}, { configDir: dir, prompts: prompts.prompts, log: out.log, writeErr: err.writeErr })

  assert.equal(isSealedToken(out.text()), false)
  assert.equal((await decodeToken(out.text(), '')).session, ACCOUNT.session)
  assert.match(err.text(), /anyone/)
})

// Rotating the passphrase without going back to the machine that has the plain session.
test('token made on a machine whose own session is sealed asks to open it first', async () => {
  const dir = await workspace({ sealed: await encodeToken(ACCOUNT, 'the old one') })
  const out = collect()
  const prompts = answers('the old one', 'the new one', 'the new one')

  await runToken([], {}, { configDir: dir, prompts: prompts.prompts, log: out.log, writeErr: () => {} })

  assert.equal((await decodeToken(out.text(), 'the new one')).session, ACCOUNT.session)
})

// Whatever happens, stdin goes back the way it was found: the interface is in raw mode while
// it asks, and a command that exits without closing it hands back a shell that no longer
// echoes what is typed into it.
test('token closes the prompt it opened even when it refuses', async () => {
  const dir = await workspace()
  const prompts = answers('one thing', 'another thing')
  let closed = false
  const watched = { ...prompts.prompts, close: () => { closed = true } }

  await assert.rejects(() => runToken([], {}, { configDir: dir, prompts: watched, writeErr: () => {} }))

  assert.equal(closed, true)
})
