import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

// Anything but a yes is a no. Both commands that ask are about to do something that cannot
// be taken back, so a stray keystroke or an empty line has to mean stop.
export async function askConfirm(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  const answer = await rl.question(question)
  rl.close()
  return /^y/i.test(answer.trim())
}
