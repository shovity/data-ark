import { defaultConfigDir, loadConfig } from '../config.js'
import { createPrompts } from '../prompt.js'
import { assertLoggedIn, unlockConfig } from '../session.js'
import { knownSettings } from '../settings.js'
import { encodeToken } from '../token.js'

// Short enough that whoever holds the token can work through the possibilities faster than
// scrypt can slow them down. Not a rule — a length minimum is a preference wearing a check's
// clothes, and the main thing one teaches is to append digits — so this warns and goes on.
const SHORT_PASSPHRASE = 12

export async function runToken(args = [], options = {}, deps = {}) {
  const {
    configDir = defaultConfigDir(),
    prompts = null,
    log = (line) => console.log(line),
    writeErr = (line) => process.stderr.write(line),
  } = deps

  const config = await loadConfig(configDir)

  // Before anything is asked for. Someone who has never logged in should be told that, not
  // asked to invent a passphrase for an account that is not there.
  assertLoggedIn(config)

  // Opened here rather than in the parameter list, so the command that refuses above never
  // touches stdin. Every question in this run goes through this one interface: asking each
  // through its own would leave the second one at end-of-input having read nothing.
  const ask = prompts ?? createPrompts({ output: process.stderr })

  try {
    return await mint(config, ask, { log, writeErr })
  } finally {
    ask.close()
  }
}

async function mint(config, ask, { log, writeErr }) {
  const readSecret = (question) => ask.askSecret(question)
  const account = await unlockConfig(config, { readSecret })

  const passphrase = await readSecret('Passphrase to protect the token: ')
  const again = await readSecret('Repeat it: ')

  if (passphrase !== again) {
    throw new Error('The two passphrases are different. Nothing was printed — run the command again.')
  }

  if (passphrase === '') {
    writeErr(
      'This token has no passphrase, so anyone who reads it can use your Telegram account. ' +
        'Do not send it through anything that keeps a copy.\n',
    )
  } else if (passphrase.length < SHORT_PASSPHRASE) {
    writeErr(
      `That passphrase is ${passphrase.length} characters. Whoever holds the token can try ` +
        'passphrases offline as fast as their hardware allows, and telstore can only make ' +
        'each attempt cost about half a second.\n',
    )
  }

  // The same true fact logout already states, said the same way: telstore cannot take a token
  // back, and the session it carries outlives every copy of the token.
  writeErr(
    'This token carries your Telegram session. telstore cannot take it back — as with ' +
      'logout, the session stays alive on Telegram\'s side until you open Telegram → ' +
      'Settings → Devices (Active sessions) and terminate it. It is about to be printed ' +
      'here, so it will sit in this terminal\'s scrollback until you clear it.\n\n',
  )

  // stdout carries the token and nothing else, the rule `config <name>` already follows, so
  // this can be piped into a QR encoder with every warning above still on the screen.
  log(
    await encodeToken(
      { ...account, settings: knownSettings(config.settings) },
      passphrase,
    ),
  )
}
