#!/usr/bin/env node
import { route, HELP } from '../src/cli.js'
import { runLogin } from '../src/commands/login.js'
import { runLogout } from '../src/commands/logout.js'
import { runRestore } from '../src/commands/restore.js'
import { runUpload } from '../src/commands/upload.js'

const SIGINT_EXIT_CODE = 130

// Lệnh đang chạy khi Ctrl-C xảy ra — mỗi lệnh có một sự thật khác nhau về việc
// tiến độ có được lưu hay không, nên phải biết đang ở lệnh nào mới chọn đúng câu.
let currentCommand = null

function sigintMessage(command) {
  if (command === 'upload') {
    return '\nĐã dừng. Tiến độ đã lưu, chạy lại lệnh cũ để đi tiếp.\n'
  }

  if (command === 'restore') {
    return '\nĐã dừng. Chưa lưu tiến độ tải, chạy lại sẽ tải lại từ đầu.\n'
  }

  return '\nĐã dừng.\n'
}

process.on('SIGINT', () => {
  process.stderr.write(sigintMessage(currentCommand))
  process.exit(SIGINT_EXIT_CODE)
})

async function main() {
  let parsed

  try {
    parsed = route(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`Lỗi: ${err.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }

  currentCommand = parsed.command

  switch (parsed.command) {
    case 'help':
      process.stdout.write(HELP)
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
      if (!parsed.args[0]) {
        throw new Error('Thiếu backup id. Ví dụ: npx data-ark restore ark-20260905-7f3a91')
      }
      await runRestore(parsed.args[0], parsed.options)
      return

    default:
      throw new Error(`Lệnh không nhận ra: ${parsed.command}`)
  }
}

// GramJS giữ lại các "exported sender" cùng một timer 30 giây để giải phóng
// chúng, và client.disconnect()/destroy() không dọn nổi: cả hai map đó là Map
// nhưng code duyệt bằng Object.values nên bỏ sót sạch. Hệ quả: lệnh in "Xong"
// rồi vẫn treo thêm ~30 giây, và Ctrl-C trong khoảng đó lại báo sai rằng chưa
// lưu được gì. Chạy xong việc là thoát hẳn, không nấn ná.
function exitWhenFlushed(code) {
  // Ghi rỗng chỉ để mượn callback: nó chạy sau khi mọi thứ xếp hàng trước đó đã
  // xả xuống pipe, nên không mất chữ nào khi stdout/stderr không phải TTY.
  let pending = 2

  const done = () => {
    pending -= 1
    if (pending === 0) process.exit(code)
  }

  // Lưới an toàn: nếu callback không bao giờ tới (pipe đã đóng) thì vẫn thoát.
  setTimeout(() => process.exit(code), 2000).unref()

  process.stdout.write('', done)
  process.stderr.write('', done)
}

main().then(
  () => {
    exitWhenFlushed(process.exitCode ?? 0)
  },
  (err) => {
    process.stderr.write(`Lỗi: ${err.message}\n`)
    process.exitCode = 1
    exitWhenFlushed(1)
  },
)
