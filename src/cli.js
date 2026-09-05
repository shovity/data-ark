import { parseArgs } from 'node:util'

const SUBCOMMANDS = new Set(['login', 'logout', 'restore', 'help'])

const OPTIONS = {
  to: { type: 'string' },
  'chunk-size': { type: 'string' },
  concurrency: { type: 'string' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
}

export const HELP = `data-ark — cắt file lớn thành chunk và lưu trữ trên Telegram

Cách dùng:
  npx data-ark login                        Đăng nhập Telegram, chỉ cần chạy một lần
  npx data-ark <file>                       Cắt file và đẩy lên Telegram
  npx data-ark restore <backup-id>          Tải về và ghép lại file gốc
  npx data-ark logout                       Xoá phiên đăng nhập đã lưu

Tuỳ chọn:
  --to <chat>            Đích lưu: @username, -100123..., hoặc me. Được ghi nhớ cho lần sau.
  --chunk-size <n>       Kích thước mỗi chunk, mặc định 1800MB. Ví dụ: 1.8GB, 500MB.
  --concurrency <n>      Số phần 512KB gửi song song, mặc định 8, tối đa 64.
  --out <đường-dẫn>      Nơi ghi file khi restore. Mặc định lấy basename của tên trong manifest.
  -h, --help             Hiện trợ giúp này.
`

export function route(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  })

  const [first, ...rest] = positionals

  if (values.help || first === undefined || first === 'help') {
    return { command: 'help', args: [], options: values }
  }

  if (SUBCOMMANDS.has(first)) {
    return { command: first, args: rest, options: values }
  }

  return { command: 'upload', args: [first], options: values }
}
