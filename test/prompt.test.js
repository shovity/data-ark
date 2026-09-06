import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { maskLine, readSecret } from '../src/prompt.js'

// readline in terminal mode drives the input the way it drives a real terminal, so the fake
// has to answer the same two questions a terminal does.
function fakeTerminal(typed) {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => input
  input.end(typed)

  return input
}

function capture() {
  const written = []
  const output = new PassThrough()
  output.write = (chunk) => {
    written.push(String(chunk))
    return true
  }

  return { output, text: () => written.join('') }
}

test('readSecret returns the line that was typed', async () => {
  const seen = capture()

  assert.equal(await readSecret('Passphrase: ', { input: fakeTerminal('hunter2\n'), output: seen.output }), 'hunter2')
})

// The whole point of the module. readline echoes what it reads through its output, so a
// writable that stops passing anything through once the question is on screen is what makes
// the typing invisible.
test('readSecret never echoes what was typed', async () => {
  const seen = capture()

  await readSecret('Passphrase: ', { input: fakeTerminal('hunter2\n'), output: seen.output })

  assert.match(seen.text(), /Passphrase: /)
  assert.doesNotMatch(seen.text(), /hunter2/)
})

// A prompt written where nobody can see it, waiting on a stream that will never carry a typed
// answer, is a hang — the one failure this project refuses to produce anywhere.
test('readSecret refuses when there is no terminal to type into', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const seen = capture()

  await assert.rejects(() => readSecret('Passphrase: ', { input, output: seen.output }), /no terminal/)
  assert.equal(seen.text(), '')
})

test('readSecret asks on stderr, so a redirected stdout still shows the question', async () => {
  const written = []
  const real = process.stderr.write

  process.stderr.write = (chunk) => {
    written.push(String(chunk))
    return true
  }

  try {
    await readSecret('Passphrase: ', { input: fakeTerminal('hunter2\n') })
  } finally {
    process.stderr.write = real
  }

  assert.match(written.join(''), /Passphrase: /)
})

// The mask has to fit the line the question is on. askSecret redraws the whole line on every
// keystroke, and that redraw clears one line only — a mask allowed to wrap would leave stale
// asterisks on the rows above it.
test('maskLine shows one asterisk per character while it fits', () => {
  assert.equal(maskLine('Passphrase: ', 7, 80), 'Passphrase: *******')
})

test('maskLine stops at the end of the line and says it stopped', () => {
  const line = maskLine('Passphrase: ', 200, 20)

  assert.equal(line, 'Passphrase: *******…')
  assert.equal(line.length, 20)
})

test('maskLine assumes 80 columns when the terminal does not say', () => {
  assert.equal(maskLine('', 80, undefined), `${'*'.repeat(79)}…`)
})

// A question wider than the terminal leaves no room, and a mask of nothing is the hang this
// change exists to end. One column is kept for it whatever the arithmetic says.
test('maskLine keeps a column of mask even when the question fills the line', () => {
  assert.equal(maskLine('Passphrase: ', 5, 4), 'Passphrase: *…')
})

test('readSecret echoes one asterisk per character typed', async () => {
  const seen = capture()

  await readSecret('Passphrase: ', { input: fakeTerminal('hunter2\n'), output: seen.output })

  assert.match(seen.text(), /Passphrase: \*{7}/)
  assert.doesNotMatch(seen.text(), /hunter2/)
  assert.doesNotMatch(seen.text(), /\*{8}/)
})

test('readSecret takes an asterisk back when a character is erased', async () => {
  const seen = capture()

  assert.equal(await readSecret('Passphrase: ', { input: fakeTerminal('abc\x7f\n'), output: seen.output }), 'ab')
  // What the screen is left holding, once every redraw has been drawn over the last one.
  assert.ok(seen.text().endsWith('Passphrase: **\n'), seen.text())
  assert.doesNotMatch(seen.text(), /abc/)
})
