import { clearSession, defaultConfigDir } from '../config.js'

export async function runLogout({ configDir = defaultConfigDir() } = {}) {
  await clearSession(configDir)
  console.log('Đã xoá phiên đăng nhập. api_id, api_hash và đích lưu vẫn được giữ lại.')
}
