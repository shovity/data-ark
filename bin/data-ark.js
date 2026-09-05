#!/usr/bin/env node
import { route, HELP } from '../src/cli.js'

async function main() {
  let parsed
  try {
    parsed = route(process.argv.slice(2))
  } catch (err) {
    console.error(`Lỗi: ${err.message}\n`)
    console.error(HELP)
    process.exitCode = 2
    return
  }

  if (parsed.command === 'help') {
    console.log(HELP)
    return
  }

  console.error(`Lệnh "${parsed.command}" chưa được cài đặt.`)
  process.exitCode = 1
}

main().catch((err) => {
  console.error(`Lỗi: ${err.message}`)
  process.exitCode = 1
})
