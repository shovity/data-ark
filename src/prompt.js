import readline from 'node:readline/promises'
import { stdin, stdout, stderr } from 'node:process'
import { Writable } from 'node:stream'

// readline echoes what it reads through its own output, so putting a curtain in front of that
// output is what makes typing invisible.
function veiledOutput(output) {
  let hidden = false

  return {
    hide: () => {
      hidden = true
    },
    show: () => {
      hidden = false
    },
    // The question goes straight to the real output, past the curtain, so it stays on screen
    // while the answer to it does not.
    say: (text) => output.write(text),
    stream: new Writable({
      write(chunk, encoding, callback) {
        if (!hidden) output.write(chunk, encoding)
        callback()
      },
    }),
  }
}

const NO_TERMINAL =
  'There is no terminal here to type a secret into. Run this where you can type it.'

// One readline for a whole conversation, some of whose answers must not stay on the screen.
// It has to be one: two readlines over a single stdin do not take turns — the first keeps the
// listener and everything typed after it lands nowhere, so the second reaches end-of-input
// having read nothing and reports it as Ctrl-D. Verified against a real terminal, because a
// fake stream takes turns perfectly well and would have called this fine.
export function createPrompts({ input = stdin, output = stdout } = {}) {
  const veil = veiledOutput(output)
  // terminal follows stdin: true is what stops the tty driver from echoing on its own, which
  // is what leaves the curtain as the only thing between the keyboard and the screen. Forcing
  // it on a pipe would put readline into line editing over input with no terminal behind it.
  const rl = readline.createInterface({ input, output: veil.stream, terminal: Boolean(input.isTTY) })

  return {
    ask: (question) => rl.question(question),
    async askSecret(question) {
      // A prompt written where nobody can see it, waiting on a stream that will never carry a
      // typed answer, is a hang — the one failure this project refuses to produce anywhere.
      // Reading it from the pipe instead would be worse: the secret would then have come from
      // somewhere that kept a copy of it.
      if (!input.isTTY) throw new Error(NO_TERMINAL)

      veil.say(question)
      veil.hide()

      try {
        return await rl.question('')
      } finally {
        veil.show()
        veil.say('\n')
      }
    },
    // Not optional: terminal mode put stdin in raw mode, and leaving it there hands the user
    // back a shell that no longer echoes what they type.
    close: () => rl.close(),
  }
}

// The single-question case. Its question goes to stderr rather than stdout, because
// "npx telstore token > token.txt" has to still show it, and stdout there carries one thing.
export async function readSecret(question, { input = stdin, output = stderr } = {}) {
  if (!input.isTTY) throw new Error(NO_TERMINAL)

  const prompts = createPrompts({ input, output })

  try {
    return await prompts.askSecret(question)
  } finally {
    prompts.close()
  }
}
