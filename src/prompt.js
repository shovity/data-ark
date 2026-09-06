import readline from 'node:readline/promises'
import { stdin, stdout, stderr } from 'node:process'
import { Writable } from 'node:stream'

// readline echoes what it reads through its own output, so putting a curtain in front of that
// output is what makes typing invisible. The curtain is also where the mask is drawn from:
// every echo readline makes is a write arriving here, and a write arriving here is the one
// signal that something was typed which does not involve reading readline's internals.
function veiledOutput(output) {
  let onEcho = null

  return {
    hide: (draw) => {
      onEcho = draw
    },
    show: () => {
      onEcho = null
    },
    // The question goes straight to the real output, past the curtain, so it stays on screen
    // while the answer to it does not.
    say: (text) => output.write(text),
    stream: new Writable({
      write(chunk, encoding, callback) {
        if (onEcho) onEcho(String(chunk))
        else output.write(chunk, encoding)
        callback()
      },
    }),
  }
}

// What the line reads while a secret is being typed. The mask is capped to the line the question
// sits on: askSecret redraws the whole line on every keystroke, and that redraw clears one line
// only, so a mask allowed to wrap would leave stale asterisks on the rows above it. The trailing
// ellipsis says the counting stopped, not the typing.
export function maskLine(question, length, columns) {
  // One column is kept back for the ellipsis, and one for the mask itself however narrow the
  // terminal is: a question that fills the line would otherwise mask to nothing, which is the
  // silence this whole thing exists to end.
  const budget = Math.max(1, (columns || 80) - question.length - 1)

  if (length <= budget) return question + '*'.repeat(length)

  return `${question}${'*'.repeat(budget)}\u2026`
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
      // The question is already on screen and carries no asterisks yet, so the first echo has
      // nothing to add. rl.line is what the mask counts — readline's own idea of the line,
      // after it has applied the keystroke, whether that was a character, a paste, a backspace
      // or a Ctrl-U.
      let drawn = question

      veil.hide((echo) => {
        // Readline announces the finished line by writing a newline, and by then it has already
        // emptied rl.line: redrawing on that would wipe the mask off the screen at the very
        // moment the answer was accepted.
        if (echo.includes('\n')) return

        const line = maskLine(question, rl.line.length, output.columns)

        // One keystroke can cost readline four writes — a redraw per write would be the same
        // line four times and a cursor that flickers for nothing.
        if (line === drawn) return

        drawn = line
        veil.say(`\x1b[2K\r${line}`)
      })

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
