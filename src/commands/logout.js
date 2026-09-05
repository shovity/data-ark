import { clearSession, defaultConfigDir } from '../config.js'

export async function runLogout({ configDir = defaultConfigDir() } = {}) {
  await clearSession(configDir)
  console.log(
    'Removed the session stored on this machine. api_id, api_hash and the destination are kept.',
  )
  console.log(
    'Note: this only deletes the local copy — the session is still alive on Telegram\'s side. ' +
      'To revoke access for good, open Telegram → Settings → Devices (Active sessions) ' +
      'and terminate that session.',
  )
}
