import { clearSession, defaultConfigDir } from '../config.js'

export async function runLogout({ configDir = defaultConfigDir() } = {}) {
  await clearSession(configDir)
  console.log(
    'Đã xoá phiên đăng nhập lưu trên máy này. api_id, api_hash và đích lưu vẫn được giữ lại.',
  )
  console.log(
    'Lưu ý: lệnh này chỉ xoá bản lưu dưới máy, phiên vẫn còn sống phía Telegram. ' +
      'Muốn cắt hẳn quyền truy cập, mở Telegram → Settings → Devices (Active sessions) ' +
      'và thu hồi phiên đó.',
  )
}
