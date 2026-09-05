import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

export function normalizeChatTarget(input) {
  const text = String(input).trim()

  if (text === '') {
    throw new Error('Đích lưu không được để rỗng.')
  }

  if (/^-?\d+$/.test(text)) {
    return Number(text)
  }

  return text
}

export function requireChat(options, config) {
  const raw = options.to ?? config.defaultChat

  if (!raw) {
    throw new Error(
      'Chưa có đích lưu — chạy lại với --to @kho_backup (hoặc --to me để dùng Saved Messages). ' +
        'Lần sau data-ark sẽ tự nhớ.',
    )
  }

  return normalizeChatTarget(raw)
}

export async function connect(config) {
  if (!config.session || !config.apiId || !config.apiHash) {
    throw new Error('Chưa đăng nhập — chạy "npx data-ark login" trước.')
  }

  const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
  })

  await client.connect()

  if (!(await client.isUserAuthorized())) {
    throw new Error('Phiên đăng nhập đã hết hạn — chạy "npx data-ark login".')
  }

  return client
}
