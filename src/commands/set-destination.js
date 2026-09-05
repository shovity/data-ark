import { normalizeChatTarget } from '../client.js'
import { defaultConfigDir, loadConfig, saveConfig } from '../config.js'

export async function runSetDestination(options = {}, deps = {}) {
  const { configDir = defaultConfigDir(), log = (line) => console.log(line) } = deps

  // Normalize before touching the config: an unusable destination must not be written,
  // or the next upload fails with an error about a value the user never really set.
  const chat = normalizeChatTarget(options.to)
  const config = await loadConfig(configDir)

  await saveConfig({ ...config, defaultChat: String(chat) }, configDir)

  log(`Destination set to ${chat}. It will be used for the next upload.`)
}
