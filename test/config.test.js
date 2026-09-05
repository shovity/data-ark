import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig, saveConfig, clearSession, defaultConfigDir } from '../src/config.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'data-ark-config-'))
}

test('defaultConfigDir trỏ vào ~/.data-ark', () => {
  assert.equal(defaultConfigDir(), path.join(os.homedir(), '.data-ark'))
})

test('loadConfig trả về object rỗng khi chưa có file', async () => {
  const dir = await tempDir()
  assert.deepEqual(await loadConfig(dir), {})
})

test('saveConfig rồi loadConfig thì lấy lại đúng dữ liệu', async () => {
  const dir = await tempDir()
  const config = { apiId: 12345, apiHash: 'abc', session: 'sess', defaultChat: '@kho' }

  await saveConfig(config, dir)

  assert.deepEqual(await loadConfig(dir), config)
})

test('saveConfig tạo được thư mục chưa tồn tại', async () => {
  const dir = path.join(await tempDir(), 'chua', 'ton', 'tai')

  await saveConfig({ defaultChat: 'me' }, dir)

  assert.deepEqual(await loadConfig(dir), { defaultChat: 'me' })
})

test('file cấu hình chỉ chủ sở hữu đọc ghi được', async () => {
  const dir = await tempDir()

  await saveConfig({ session: 'bí mật' }, dir)

  const stat = await fs.stat(path.join(dir, 'config.json'))
  assert.equal(stat.mode & 0o777, 0o600)
})

test('saveConfig không để lại file tạm', async () => {
  const dir = await tempDir()

  await saveConfig({ defaultChat: 'me' }, dir)

  assert.deepEqual(await fs.readdir(dir), ['config.json'])
})

test('clearSession xoá session nhưng giữ phần còn lại', async () => {
  const dir = await tempDir()
  await saveConfig({ apiId: 1, apiHash: 'h', session: 's', defaultChat: '@kho' }, dir)

  await clearSession(dir)

  assert.deepEqual(await loadConfig(dir), { apiId: 1, apiHash: 'h', defaultChat: '@kho' })
})

test('loadConfig báo lỗi rõ ràng khi file hỏng', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'config.json'), '{ hỏng')

  await assert.rejects(() => loadConfig(dir), /cấu hình/)
})
