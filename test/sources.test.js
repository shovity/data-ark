import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { expandSources } from '../src/sources.js'

import { tempDir } from './helpers.js'

// A tree written from one literal, so what a test claims about the layout is the layout.
async function tree(entries) {
  const dir = await tempDir('sources')

  for (const [name, content] of Object.entries(entries)) {
    const full = path.join(dir, name)

    if (content === null) {
      await fs.mkdir(full, { recursive: true })
      continue
    }

    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }

  return dir
}

function names(dir, paths) {
  return paths.map((p) => path.relative(dir, p))
}

test('a folder becomes every file inside it, sorted, one level down', async () => {
  const dir = await tree({ 'b.tar': 'b', 'a.tar': 'a', 'c.bin': 'c' })

  const { paths } = await expandSources([dir])

  assert.deepEqual(names(dir, paths), ['a.tar', 'b.tar', 'c.bin'])
})

test('a folder does not walk into its subfolders, and says which it left', async () => {
  const dir = await tree({ 'a.tar': 'a', 'sub/deep.tar': 'deep', nested: null })

  const { paths, skipped } = await expandSources([dir])

  assert.deepEqual(names(dir, paths), ['a.tar'])
  assert.deepEqual(
    skipped.map((entry) => ({ name: path.basename(entry.path), reason: entry.reason })),
    [
      { name: 'nested', reason: 'directory' },
      { name: 'sub', reason: 'directory' },
    ],
  )
})

test('a folder leaves out dotfiles', async () => {
  const dir = await tree({ 'a.tar': 'a', '.env': 'secret', '.DS_Store': 'x' })

  const { paths, skipped } = await expandSources([dir])

  assert.deepEqual(names(dir, paths), ['a.tar'])
  assert.deepEqual(skipped, [])
})

test('an empty folder is refused by name rather than uploading nothing', async () => {
  const dir = await tree({ 'keep/me': null })
  const empty = path.join(dir, 'keep')

  await assert.rejects(() => expandSources([empty]), new RegExp(`${empty} has no files`))
})

test('a folder holding only subfolders names them in the refusal', async () => {
  const dir = await tree({ 'sub/deep.tar': 'deep' })

  await assert.rejects(() => expandSources([dir]), (err) => {
    assert.match(err.message, /has no files/)
    assert.match(err.message, /sub/)
    return true
  })
})

test('a pattern matches only what it names, in the folder it names', async () => {
  const dir = await tree({ 'a.tar': 'a', 'b.tar': 'b', 'c.bin': 'c', 'sub/d.tar': 'd' })

  const { paths } = await expandSources([path.join(dir, '*.tar')])

  assert.deepEqual(names(dir, paths), ['a.tar', 'b.tar'])
})

test('a prefix pattern matches by prefix', async () => {
  const dir = await tree({ 'abc-1.tar': '1', 'abc-2.tar': '2', 'xyz.tar': 'x' })

  const { paths } = await expandSources([path.join(dir, 'abc*')])

  assert.deepEqual(names(dir, paths), ['abc-1.tar', 'abc-2.tar'])
})

test('? stands for exactly one character', async () => {
  const dir = await tree({ 'a1.tar': '1', 'a12.tar': '2' })

  const { paths } = await expandSources([path.join(dir, 'a?.tar')])

  assert.deepEqual(names(dir, paths), ['a1.tar'])
})

test('a pattern skips dotfiles unless it asks for them itself', async () => {
  const dir = await tree({ '.hidden.tar': 'h', 'shown.tar': 's' })

  const { paths: plain } = await expandSources([path.join(dir, '*.tar')])
  assert.deepEqual(names(dir, plain), ['shown.tar'])

  const { paths: dotted } = await expandSources([path.join(dir, '.*.tar')])
  assert.deepEqual(names(dir, dotted), ['.hidden.tar'])
})

test('a pattern that matches nothing is refused, naming the pattern and the folder', async () => {
  const dir = await tree({ 'a.tar': 'a' })
  const pattern = path.join(dir, '*.zip')

  await assert.rejects(() => expandSources([pattern]), (err) => {
    assert.match(err.message, /No file matches/)
    assert.match(err.message, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(err.message, new RegExp(dir))
    return true
  })
})

test('a pattern whose folder does not exist says so, rather than "matches nothing"', async () => {
  const dir = await tree({ 'a.tar': 'a' })
  const pattern = path.join(dir, 'nowhere', '*.tar')

  await assert.rejects(() => expandSources([pattern]), /does not exist/)
})

test('a wildcard outside the last part of the path is refused', async () => {
  const dir = await tree({ 'sub/a.tar': 'a' })

  await assert.rejects(
    () => expandSources([path.join(dir, '*', 'a.tar')]),
    /only work in the last part/,
  )
})

test('a pattern never matches a folder, only files', async () => {
  const dir = await tree({ 'a.tar': 'a', 'b.tar': null })

  const { paths } = await expandSources([path.join(dir, '*.tar')])

  assert.deepEqual(names(dir, paths), ['a.tar'])
})

test('an ordinary path is handed on untouched, even one that does not exist', async () => {
  const dir = await tree({ 'a.tar': 'a' })
  const missing = path.join(dir, 'gone.tar')

  const { paths } = await expandSources([path.join(dir, 'a.tar'), missing])

  assert.deepEqual(paths, [path.join(dir, 'a.tar'), missing])
})

test('arguments keep the order they were typed in', async () => {
  const dir = await tree({ 'z.tar': 'z', 'folder/b.tar': 'b', 'folder/a.tar': 'a' })

  const { paths } = await expandSources([path.join(dir, 'z.tar'), path.join(dir, 'folder')])

  assert.deepEqual(names(dir, paths), ['z.tar', 'folder/a.tar', 'folder/b.tar'])
})
