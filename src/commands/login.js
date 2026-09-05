import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

import { loadConfig, saveConfig, defaultConfigDir } from '../config.js'
import { normalizeChatTarget } from '../client.js'

function createPrompts() {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  return {
    ask: (question) => rl.question(question),
    close: () => rl.close(),
  }
}

const LOGIN_ERROR_MESSAGES = {
  PHONE_NUMBER_INVALID: 'số điện thoại không hợp lệ',
  PHONE_CODE_INVALID: 'mã xác nhận sai',
  PHONE_CODE_EXPIRED: 'mã xác nhận đã hết hạn',
  PASSWORD_HASH_INVALID: 'mật khẩu hai lớp sai',
  FLOOD_WAIT: 'bị Telegram giới hạn tần suất, cần chờ',
}

export function describeLoginError(err) {
  const message = String(err?.message ?? err ?? '')
  const known = Object.entries(LOGIN_ERROR_MESSAGES).find(([code]) => message.startsWith(code))

  if (!known) return message

  const [, description] = known
  return `${description} (${message})`
}

export async function runLogin({ configDir = defaultConfigDir(), prompts = createPrompts() } = {}) {
  const config = await loadConfig(configDir)

  console.log('Cần api_id và api_hash của riêng bạn. Lấy tại https://my.telegram.org → API development tools.\n')

  const apiIdAnswer = (await prompts.ask(`api_id${config.apiId ? ` [${config.apiId}]` : ''}: `)).trim()

  if (apiIdAnswer !== '' && !/^\d+$/.test(apiIdAnswer)) {
    prompts.close()
    throw new Error('api_id phải là số nguyên.')
  }

  const apiId = apiIdAnswer === '' ? config.apiId : Number(apiIdAnswer)
  const apiHash = (await prompts.ask(`api_hash${config.apiHash ? ' [giữ nguyên]' : ''}: `)) || config.apiHash

  if (!apiId || !apiHash) {
    prompts.close()
    throw new Error('Thiếu api_id hoặc api_hash.')
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 })

  await client.start({
    phoneNumber: () => prompts.ask('Số điện thoại (dạng +84...): '),
    phoneCode: () => prompts.ask('Mã xác nhận Telegram vừa gửi: '),
    password: () => prompts.ask('Mật khẩu hai lớp (bỏ trống nếu không bật): '),
    onError: (err) => console.error(`Lỗi đăng nhập: ${describeLoginError(err)}`),
  })

  const me = await client.getMe()
  const session = client.session.save()
  await client.disconnect()

  const chatAnswer = (
    await prompts.ask(
      `Đẩy backup vào chat nào? (@username, -100..., hoặc me)${config.defaultChat ? ` [${config.defaultChat}]` : ''}, Enter để bỏ qua: `,
    )
  ).trim()

  prompts.close()

  const next = { ...config, apiId, apiHash, session }

  if (chatAnswer !== '') {
    next.defaultChat = String(normalizeChatTarget(chatAnswer))
  }

  await saveConfig(next, configDir)

  console.log(`\nĐã đăng nhập với tài khoản ${me.username ? `@${me.username}` : me.firstName}.`)
  console.log(`Cấu hình đã lưu vào ${configDir}/config.json`)
}
