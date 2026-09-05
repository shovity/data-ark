import { promises as fs } from 'node:fs'
import path from 'node:path'

import { Api } from 'telegram'
import { CustomFile } from 'telegram/client/uploads.js'

import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  PART_SIZE,
  parseSize,
  planChunks,
} from '../chunking.js'
import { connect as realConnect, requireChat } from '../client.js'
import { defaultConfigDir, loadConfig, saveConfig } from '../config.js'
import {
  buildManifest,
  chunkFileName,
  manifestFileName,
  newBackupId,
  serializeManifest,
} from '../manifest.js'
import { createProgress, formatBytes, formatDuration } from '../progress.js'
import { clearState, loadState, markChunkDone, saveState, stateDir, stateKey } from '../state.js'
import { uploadRange } from '../uploader.js'

// Trên ngưỡng này thì phải nói rõ đang chờ bao lâu, theo spec §8.
const LONG_WAIT_MS = 60_000

async function realSendChunk(client, peer, { inputFile, fileName, caption }) {
  return await client.sendFile(peer, {
    file: inputFile,
    caption,
    forceDocument: true,
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
  })
}

async function realSendManifest(client, peer, { bytes, fileName, caption }) {
  return await client.sendFile(peer, {
    file: new CustomFile(fileName, bytes.length, '', bytes),
    caption,
    forceDocument: true,
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
  })
}

export async function runUpload(filePath, options = {}, deps = {}) {
  const {
    connect = realConnect,
    sendChunk = realSendChunk,
    sendManifest = realSendManifest,
    disconnect = (client) => client.destroy(),
    configDir = defaultConfigDir(),
    partSize = PART_SIZE,
    retryOptions = {},
    writeErr = (line) => process.stderr.write(line),
    silent = false,
  } = deps

  const absPath = path.resolve(filePath)

  let stat
  try {
    stat = await fs.stat(absPath)
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`File không tồn tại: ${absPath}`)
    throw err
  }

  if (!stat.isFile()) {
    throw new Error(`${absPath} không phải là file.`)
  }

  const config = await loadConfig(configDir)
  const chat = requireChat(options, config)
  const chunkSize = options['chunk-size'] ? parseSize(options['chunk-size']) : DEFAULT_CHUNK_SIZE
  const concurrency = options.concurrency ? Number(options.concurrency) : DEFAULT_CONCURRENCY

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(
      `--concurrency không hợp lệ: "${options.concurrency}". ` +
        `Phải là số nguyên từ 1 đến ${MAX_CONCURRENCY} — mỗi luồng giữ một phần 512KB trong RAM ` +
        'và Telegram sẽ bắt chờ FLOOD_WAIT nếu bắn quá nhiều request cùng lúc.',
    )
  }

  const chunks = planChunks(stat.size, chunkSize)
  const key = stateKey(absPath, stat.size, stat.mtimeMs)

  let state = await loadState(key, configDir)
  const resuming = Boolean(state) && state.chunkSize === chunkSize

  if (resuming && state.chat !== String(chat)) {
    const stateFile = path.join(stateDir(configDir), `${key}.json`)
    throw new Error(
      `Backup dở dang này đang gửi vào ${state.chat}, nhưng lệnh hiện tại chỉ định đích ${chat} — ` +
        `không thể tách một backup ra hai đích khác nhau. Chạy lại không kèm --to để tiếp tục gửi vào ` +
        `${state.chat}, hoặc xoá ${stateFile} rồi chạy lại để bắt đầu backup mới vào ${chat}.`,
    )
  }

  if (options.to) {
    await saveConfig({ ...config, defaultChat: String(chat) }, configDir)
  }

  if (!resuming) {
    state = {
      id: newBackupId(),
      chat: String(chat),
      path: absPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      chunkSize,
      done: {},
    }
    await saveState(key, state, configDir)
  }

  const log = silent ? () => {} : (line) => console.log(line)
  const warn = silent ? () => {} : writeErr

  // Thử lại và FLOOD_WAIT phải nói ra: một FLOOD_WAIT_3600 mà im lặng thì người
  // dùng chỉ thấy thanh tiến độ đứng hình cả tiếng và tưởng máy treo.
  function onRetry(err, attempt, delayMs) {
    if (delayMs > LONG_WAIT_MS) {
      warn(
        `\nTelegram bắt chờ ${formatDuration(delayMs / 1000)} rồi mới cho gửi tiếp ` +
          `(${err.message}). data-ark đang đợi và sẽ tự đi tiếp, đừng tắt.\n`,
      )
      return
    }

    warn(
      `\nLỗi tạm thời (${err.message}), thử lại lần ${attempt} sau ` +
        `${formatDuration(delayMs / 1000)}.\n`,
    )
  }

  log(`Backup ${state.id}`)
  log(`File   ${absPath} (${formatBytes(stat.size)}, ${chunks.length} chunk)`)
  log(`Đích   ${chat}\n`)

  const client = await connect(config)

  try {
    for (const chunk of chunks) {
      if (state.done[String(chunk.i)]) {
        log(`Chunk ${chunk.i + 1}/${chunks.length} đã có, bỏ qua.`)
        continue
      }

      const fileName = chunkFileName(state.id, chunk.i)
      const handle = await fs.open(absPath, 'r')

      const progress = silent
        ? { advance: () => {}, finish: () => {} }
        : createProgress({
            total: chunk.length,
            label: `Chunk ${chunk.i + 1}/${chunks.length}`,
            write: writeErr,
          })

      try {
        const { inputFile, sha256 } = await uploadRange(client, handle.fd, {
          offset: chunk.offset,
          length: chunk.length,
          fileName,
          concurrency,
          partSize,
          onProgress: (bytes) => progress.advance(bytes),
          retryOptions: { ...retryOptions, onRetry },
        })

        progress.finish()

        const message = await sendChunk(client, chat, {
          inputFile,
          fileName,
          caption: `#dataark ${state.id} ${chunk.i + 1}/${chunks.length}`,
        })

        state = await markChunkDone(
          key,
          state,
          chunk.i,
          { msgId: message.id, size: chunk.length, sha256 },
          configDir,
        )
      } finally {
        await handle.close()
      }
    }

    // File có thể bị ghi đè trong lúc upload — với file 50GB thì cả tiếng đồng
    // hồ trôi qua giữa chunk đầu và chunk cuối. Khi đó manifest mô tả một file
    // lai chưa từng tồn tại: restore vẫn khớp sha256 nhưng dữ liệu là rác.
    const after = await fs.stat(absPath)

    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error(
        `${absPath} đã thay đổi trong lúc upload ` +
          `(kích thước ${stat.size} → ${after.size}, mtime ${stat.mtimeMs} → ${after.mtimeMs}). ` +
          'Backup này trộn dữ liệu cũ với dữ liệu mới nên không đáng tin — data-ark không gửi manifest. ' +
          'Chờ file ổn định rồi chạy lại để tạo một backup mới.',
      )
    }

    const manifest = buildManifest({
      id: state.id,
      name: path.basename(absPath),
      size: stat.size,
      chunkSize,
      chunks: chunks.map((chunk) => ({ i: chunk.i, ...state.done[String(chunk.i)] })),
    })

    await sendManifest(client, chat, {
      bytes: serializeManifest(manifest),
      fileName: manifestFileName(state.id),
      caption: `#dataark ${state.id} manifest`,
    })

    await clearState(key, configDir)

    log(`\nXong. Khôi phục bằng:\n  npx data-ark restore ${state.id}`)

    return { id: state.id, chunks: chunks.length }
  } finally {
    // Ngắt kết nối hỏng thì cũng không được nuốt mất lỗi thật đang bay lên.
    try {
      await disconnect(client)
    } catch (err) {
      warn(`\nCảnh báo: không đóng được kết nối Telegram: ${err.message}\n`)
    }
  }
}
