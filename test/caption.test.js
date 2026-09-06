import test from 'node:test'
import assert from 'node:assert/strict'

import { chunkCaption, manifestCaption, parseManifestCaption } from '../src/caption.js'

test('a chunk caption names the backup and its position in the set', () => {
  assert.equal(chunkCaption({ id: 'telstore-20260905-7f3a91', number: 3, total: 12 }), '📦 telstore-20260905-7f3a91 · 3/12')
})

// restore finds the manifest with `search: backupId`, so every caption telstore
// writes has to keep the id searchable as one whole word.
test('a chunk caption keeps the backup id searchable', () => {
  const caption = chunkCaption({ id: 'telstore-20260905-7f3a91', number: 1, total: 1 })

  assert.match(caption, /(^|\s)telstore-20260905-7f3a91(\s|$)/)
})

test('a manifest caption is a summary card of the whole backup', () => {
  const caption = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 22_998_546_842,
    chunks: 12,
    createdAt: '2026-09-05T16:40:12.000Z',
  })

  assert.equal(
    caption,
    [
      '🗄 data.tar',
      '💾 21.4 GB · 12 chunks',
      '🆔 telstore-20260905-7f3a91',
      '📅 2026-09-05 16:40 UTC',
      '',
      '↩ npx telstore restore telstore-20260905-7f3a91',
      '#telstore',
    ].join('\n'),
  )
})

test('a manifest caption counts a single chunk in the singular', () => {
  const caption = manifestCaption({
    id: 'telstore-20260901-9de447',
    name: 'photos.zip',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
  })

  assert.match(caption, /· 1 chunk$/m)
})

// A file name may legally contain a newline. Written straight into the caption it
// would push every following line one row down and break the card apart.
test('a manifest caption flattens line breaks in the file name', () => {
  const caption = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'two\nlines.tar',
    size: 1024,
    chunks: 1,
    createdAt: '2026-09-05T16:40:12.000Z',
  })

  assert.equal(caption.split('\n')[0], '🗄 two lines.tar')
  assert.equal(caption.split('\n').length, 7)
})

test('a manifest caption parses back into the fields it was built from', () => {
  const built = manifestCaption({
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: 22_998_546_842,
    chunks: 12,
    createdAt: '2026-09-05T16:40:12.000Z',
  })

  assert.deepEqual(parseManifestCaption(built), {
    id: 'telstore-20260905-7f3a91',
    name: 'data.tar',
    size: '21.4 GB',
    chunks: 12,
    createdAt: '2026-09-05 16:40 UTC',
  })
})

// Backups uploaded by earlier versions carry "#telstore <id> manifest" and nothing else.
// list still has to show them, so parsing has to say "I don't know" rather than guess.
test('a caption from an older release parses as unknown', () => {
  assert.equal(parseManifestCaption('#telstore telstore-20260905-7f3a91 manifest'), null)
})

test('an unrelated message parses as unknown', () => {
  assert.equal(parseManifestCaption('here are my holiday photos'), null)
})

test('a card someone edited down to nothing parses as unknown', () => {
  assert.equal(parseManifestCaption('🗄 data.tar\n#telstore'), null)
})
