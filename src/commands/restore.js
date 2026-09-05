import { promises as fs } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { Api } from 'telegram'

import { connect as realConnect, requireChat } from '../client.js'
import { defaultConfigDir, loadConfig } from '../config.js'
import { downloadToFile } from '../downloader.js'
import { manifestFileName, parseManifest } from '../manifest.js'
import { createProgress, formatBytes } from '../progress.js'

function documentFileName(message) {
  const attributes = message?.media?.document?.attributes ?? []
  const named = attributes.find((a) => a instanceof Api.DocumentAttributeFilename)
  return named?.fileName ?? null
}

async function realSearchManifest(client, peer, backupId) {
  const wanted = manifestFileName(backupId)

  // Dùng client.getMessages thay vì raw Api.messages.Search: nó tự lo offset,
  // hash và phân trang, nên không phải tự dựng các trường dễ sai kiểu.
  const messages = await client.getMessages(peer, {
    search: backupId,
    filter: new Api.InputMessagesFilterDocument(),
    limit: 100,
  })

  return messages.find((m) => documentFileName(m) === wanted) ?? null
}

async function realReadMessageBytes(client, message) {
  return await client.downloadMedia(message)
}

async function realGetMessage(client, peer, msgId) {
  const [message] = await client.getMessages(peer, { ids: [msgId] })
  return message ?? null
}

export async function realDownloadChunk(client, message, handle, offset, onProgress) {
  return await downloadToFile(client, message, handle.fd, { offset, onProgress })
}

async function askConfirm(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  const answer = await rl.question(question)
  rl.close()
  return /^(c|y)/i.test(answer.trim())
}

export async function runRestore(backupId, options = {}, deps = {}) {
  const {
    connect = realConnect,
    disconnect = (client) => client.disconnect(),
    configDir = defaultConfigDir(),
    searchManifest = realSearchManifest,
    readMessageBytes = realReadMessageBytes,
    getMessage = realGetMessage,
    downloadChunk = realDownloadChunk,
    confirm = askConfirm,
    silent = false,
  } = deps

  const config = await loadConfig(configDir)
  const chat = requireChat(options, config)
  const log = silent ? () => {} : (line) => console.log(line)

  const client = await connect(config)

  try {
    const manifestMessage = await searchManifest(client, chat, backupId)

    if (!manifestMessage) {
      throw new Error(
        `Không tìm thấy manifest của ${backupId} trong ${chat}. ` +
          'Kiểm tra lại backup id, hoặc dùng --to để trỏ đúng chat.',
      )
    }

    const manifest = parseManifest(await readMessageBytes(client, manifestMessage))
    // manifest.name đến từ dữ liệu tải về Telegram — không tin nó khi tự chọn
    // đường dẫn: chỉ lấy basename để tránh path traversal kiểu "../../x".
    // Khi người dùng tự chỉ định --out thì tôn trọng nguyên văn đường dẫn đó.
    const target = path.resolve(options.out ?? path.basename(manifest.name))
    const partial = `${target}.partial`

    const exists = await fs.stat(target).then(() => true, () => false)

    if (exists && !(await confirm(`${target} đã tồn tại. Ghi đè? [c/K] `))) {
      throw new Error('Đã huỷ theo yêu cầu.')
    }

    log(`Backup ${manifest.id}`)
    log(`File   ${target} (${formatBytes(manifest.size)}, ${manifest.chunks.length} chunk)\n`)

    const handle = await fs.open(partial, 'w+')

    try {
      await handle.truncate(manifest.size)

      for (const chunk of manifest.chunks) {
        const message = await getMessage(client, chat, chunk.msgId)

        if (!message) {
          throw new Error(
            `Thiếu chunk ${chunk.i + 1}/${manifest.chunks.length}: message ${chunk.msgId} không còn trong ${chat}. ` +
              'Backup này không khôi phục được.',
          )
        }

        const progress = silent
          ? { advance: () => {}, finish: () => {} }
          : createProgress({
              total: chunk.size,
              label: `Chunk ${chunk.i + 1}/${manifest.chunks.length}`,
            })

        const { sha256, size } = await downloadChunk(
          client,
          message,
          handle,
          chunk.i * manifest.chunkSize,
          progress.advance,
        )

        progress.finish()

        if (size !== chunk.size) {
          throw new Error(
            `Chunk ${chunk.i + 1} có ${size} byte, manifest ghi ${chunk.size} byte — không khớp.`,
          )
        }

        if (sha256 !== chunk.sha256) {
          throw new Error(
            `Chunk ${chunk.i + 1} có sha256 không khớp manifest. File tải về giữ ở ${partial} để kiểm tra.`,
          )
        }
      }
    } finally {
      await handle.close()
    }

    await fs.rename(partial, target)

    log(`\nXong. Đã ghi ${formatBytes(manifest.size)} vào ${target}`)

    return { path: target, size: manifest.size }
  } finally {
    await disconnect(client)
  }
}
