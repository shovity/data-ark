import test from 'node:test'
import assert from 'node:assert/strict'

import { route } from '../src/cli.js'

test('a first argument that is not a subcommand is treated as a file to upload', () => {
  const r = route(['data.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['data.tar'])
})

test('a path with slashes is still an upload', () => {
  const r = route(['./backups/data.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['./backups/data.tar'])
})

test('restore is recognised as a subcommand with a backup id', () => {
  const r = route(['restore', 'ark-20260905-7f3a91'])
  assert.equal(r.command, 'restore')
  assert.deepEqual(r.args, ['ark-20260905-7f3a91'])
})

test('login and logout are subcommands', () => {
  assert.equal(route(['login']).command, 'login')
  assert.equal(route(['logout']).command, 'logout')
})

test('no arguments shows the help', () => {
  assert.equal(route([]).command, 'help')
})

test('the accompanying flags are parsed', () => {
  const r = route(['data.tar', '--to', '@my_backups', '--chunk-size', '1.8GB', '--concurrency', '4'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['data.tar'])
  assert.equal(r.options.to, '@my_backups')
  assert.equal(r.options['chunk-size'], '1.8GB')
  assert.equal(r.options.concurrency, '4')
})

test('the --out flag belongs to restore', () => {
  const r = route(['restore', 'ark-1', '--out', '/tmp/out.tar'])
  assert.equal(r.command, 'restore')
  assert.equal(r.options.out, '/tmp/out.tar')
})

test('an invalid flag produces a clear error', () => {
  assert.throws(() => route(['data.tar', '--does-not-exist']), /--does-not-exist/)
})
