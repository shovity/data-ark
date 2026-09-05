#!/usr/bin/env node
import { route, HELP } from '../src/cli.js'
import { runLogin } from '../src/commands/login.js'
import { runLogout } from '../src/commands/logout.js'
import { runUpload } from '../src/commands/upload.js'
import { runRestore } from '../src/commands/restore.js'

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

  switch (parsed.command) {
    case 'help':
      console.log(HELP)
      return
    case 'login':
      await runLogin()
      return
    case 'logout':
      await runLogout()
      return
    case 'upload':
      await runUpload(parsed.args[0], parsed.options)
      return
    case 'restore':
      if (!parsed.args[0]) throw new Error('Thiếu backup id. Ví dụ: npx data-ark restore ark-20260905-7f3a91')
      await runRestore(parsed.args[0], parsed.options)
      return
    default:
      console.error(`Lệnh "${parsed.command}" chưa được cài đặt.`)
      process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`Lỗi: ${err.message}`)
  process.exitCode = 1
})
