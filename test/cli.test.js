import test from 'node:test'
import assert from 'node:assert/strict'

import { route, interruptMessage } from '../src/cli.js'

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

test('--verbose is parsed as a flag', () => {
  assert.equal(route(['big.iso', '--verbose']).options.verbose, true)
  assert.equal(route(['big.iso']).options.verbose, undefined)
  assert.equal(route(['restore', 'ark-1', '--verbose']).options.verbose, true)
})

test('a negative channel id is accepted separated by a space, not only with =', () => {
  assert.equal(route(['data.tar', '--to', '-1001234567890']).options.to, '-1001234567890')
  assert.equal(route(['data.tar', '--to=-1001234567890']).options.to, '-1001234567890')
  assert.equal(route(['restore', 'ark-1', '--to', '-100123']).options.to, '-100123')
})

test('joining a negative value does not swallow the flag that follows --to', () => {
  assert.throws(() => route(['data.tar', '--to', '--verbose']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' })
})

test('a --to after -- stays a positional', () => {
  assert.equal(route(['data.tar', '--', '--to', '-100123']).options.to, undefined)
})

test('status is a subcommand', () => {
  const r = route(['status'])
  assert.equal(r.command, 'status')
  assert.deepEqual(r.args, [])
  assert.equal(route(['status', '--verbose']).options.verbose, true)
})

test('--to without a file only sets the destination', () => {
  const r = route(['--to', '@my_backups'])
  assert.equal(r.command, 'set-destination')
  assert.deepEqual(r.args, [])
  assert.equal(r.options.to, '@my_backups')
  assert.equal(route(['--to', '-1001234567890']).command, 'set-destination')
})

test('--to with a file still uploads', () => {
  assert.equal(route(['data.tar', '--to', '@my_backups']).command, 'upload')
})

test('no arguments at all is still help', () => {
  assert.equal(route([]).command, 'help')
  assert.equal(route(['--chunk-size', '1GB']).command, 'help')
})

test('list is a subcommand, not a file to upload', () => {
  const parsed = route(['list'])

  assert.equal(parsed.command, 'list')
  assert.deepEqual(parsed.args, [])
})

test('list takes --limit and --to', () => {
  const parsed = route(['list', '--limit', '5', '--to', '@store'])

  assert.equal(parsed.command, 'list')
  assert.equal(parsed.options.limit, '5')
  assert.equal(parsed.options.to, '@store')
})

test('interrupting an upload names the backup and how to carry on', () => {
  const message = interruptMessage('upload', { backupId: 'ark-20260905-7f3a91' })

  assert.match(message, /ark-20260905-7f3a91/)
  assert.match(message, /run the same command again/)
  assert.match(message, /data-ark status/)
})

test('interrupting an upload before it has an id still promises nothing false', () => {
  const message = interruptMessage('upload')

  assert.match(message, /run the same command again/)
  assert.doesNotMatch(message, /undefined/)
})

test('interrupting a restore says the download is lost', () => {
  assert.match(interruptMessage('restore'), /starts over/)
})

test('interrupting anything else just says it stopped', () => {
  assert.equal(interruptMessage('login'), '\nStopped.\n')
  assert.equal(interruptMessage(null), '\nStopped.\n')
})
