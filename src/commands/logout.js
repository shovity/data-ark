import { clearSession, defaultConfigDir, loadConfig } from '../config.js'

// The same true fact in both cases — the session outlives this machine — but not the same
// sentence about what is left behind. An ordinary login keeps the api_id and api_hash beside
// the session, and a sealed one keeps them inside it, so there the api_hash goes too. Saying
// otherwise would describe a machine other than the one in front of the reader.
export async function runLogout({ configDir = defaultConfigDir(), log = (line) => console.log(line) } = {}) {
  const { sealed } = await loadConfig(configDir)

  await clearSession(configDir)

  log(
    sealed
      ? 'Removed the sealed session stored on this machine. The api_id and api_hash were ' +
          'inside it, so they are gone with it; the destination is kept.'
      : 'Removed the session stored on this machine. api_id, api_hash and the destination are kept.',
  )
  log(
    'Note: this only deletes the local copy — the session is still alive on Telegram\'s side. ' +
      'To revoke access for good, open Telegram → Settings → Devices (Active sessions) ' +
      'and terminate that session.',
  )
}
