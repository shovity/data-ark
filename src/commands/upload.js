import { promises as fs } from 'node:fs'
import path from 'node:path'

import { Api } from 'telegram'
import { CustomFile } from 'telegram/client/uploads.js'

import { DEFAULT_CHUNK_SIZE, PART_SIZE, parseSize, planChunks } from '../chunking.js'
import { connect as realConnect, requireChat } from '../client.js'
import { defaultConfigDir, loadConfig, saveConfig } from '../config.js'
import {
  buildManifest,
  chunkFileName,
  manifestFileName,
  newBackupId,
  serializeManifest,
} from '../manifest.js'
import { createProgress, formatBytes } from '../progress.js'
import { clearState, loadState, markChunkDone, saveState, stateKey } from '../state.js'
import { uploadRange } from '../uploader.js'

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
    disconnect = (client) => client.disconnect(),
    configDir = defaultConfigDir(),
    partSize = PART_SIZE,
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
  const concurrency = options.concurrency ? Number(options.concurrency) : 8

  if (options.to) {
    await saveConfig({ ...config, defaultChat: String(chat) }, configDir)
  }

  const chunks = planChunks(stat.size, chunkSize)
  const key = stateKey(absPath, stat.size, stat.mtimeMs)

  let state = await loadState(key, configDir)

  if (!state || state.chunkSize !== chunkSize) {
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
        : createProgress({ total: chunk.length, label: `Chunk ${chunk.i + 1}/${chunks.length}` })

      try {
        const { inputFile, sha256 } = await uploadRange(client, handle.fd, {
          offset: chunk.offset,
          length: chunk.length,
          fileName,
          concurrency,
          partSize,
          onProgress: (bytes) => progress.advance(bytes),
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
    await disconnect(client)
  }
}
