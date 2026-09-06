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
  const r = route(['restore', 'telark-20260905-7f3a91'])
  assert.equal(r.command, 'restore')
  assert.deepEqual(r.args, ['telark-20260905-7f3a91'])
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
  const r = route(['restore', 'telark-1', '--out', '/tmp/out.tar'])
  assert.equal(r.command, 'restore')
  assert.equal(r.options.out, '/tmp/out.tar')
})

test('an invalid flag produces a clear error', () => {
  assert.throws(() => route(['data.tar', '--does-not-exist']), /--does-not-exist/)
})

test('--verbose is parsed as a flag', () => {
  assert.equal(route(['big.iso', '--verbose']).options.verbose, true)
  assert.equal(route(['big.iso']).options.verbose, undefined)
  assert.equal(route(['restore', 'telark-1', '--verbose']).options.verbose, true)
})

test('a negative channel id is accepted separated by a space, not only with =', () => {
  assert.equal(route(['data.tar', '--to', '-1001234567890']).options.to, '-1001234567890')
  assert.equal(route(['data.tar', '--to=-1001234567890']).options.to, '-1001234567890')
  assert.equal(route(['restore', 'telark-1', '--to', '-100123']).options.to, '-100123')
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

test('--to without a file points at the command that actually saves a destination', () => {
  assert.throws(() => route(['--to', '@my_backups']), /telark config chat @my_backups/)
  assert.throws(() => route(['--to', '-1001234567890']), /telark config chat -1001234567890/)
})

test('--to with --help is still help, not an error', () => {
  assert.equal(route(['--to', '@my_backups', '--help']).command, 'help')
})

test('config is a subcommand and carries its key and value as arguments', () => {
  assert.equal(route(['config']).command, 'config')
  assert.deepEqual(route(['config']).args, [])
  assert.deepEqual(route(['config', 'chat']).args, ['chat'])
  assert.deepEqual(route(['config', 'chat', '@my_backups']).args, ['chat', '@my_backups'])
})

test('a negative channel id survives as a config value, where there is no flag to join it to', () => {
  assert.deepEqual(route(['config', 'chat', '-1001234567890']).args, ['chat', '-1001234567890'])
})

test('--unset reaches the config command', () => {
  const r = route(['config', 'chat', '--unset'])
  assert.equal(r.command, 'config')
  assert.deepEqual(r.args, ['chat'])
  assert.equal(r.options.unset, true)
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
  const message = interruptMessage('upload', { backupId: 'telark-20260905-7f3a91' })

  assert.match(message, /telark-20260905-7f3a91/)
  assert.match(message, /run the same command again/)
  assert.match(message, /telark status/)
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

test('delete is a subcommand carrying the backup id', () => {
  const r = route(['delete', 'telark-20260905-7f3a91'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, ['telark-20260905-7f3a91'])
})

test('delete without an id is still routed, so the command can say what is missing', () => {
  const r = route(['delete'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, [])
})

test('--yes is a flag, present only when it was typed', () => {
  assert.equal(route(['delete', 'telark-1', '--yes']).options.yes, true)
  assert.equal(route(['delete', 'telark-1']).options.yes, undefined)
})

test('delete reaches a negative channel id like every other command', () => {
  const r = route(['delete', 'telark-1', '--to', '-1001234567890'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, ['telark-1'])
  assert.equal(r.options.to, '-1001234567890')
})

// Ctrl-C during a delete has already destroyed messages for good, and the manifest is
// deliberately still there. Saying "Stopped." alone would read as "nothing happened".
test('Ctrl-C during a delete says some chunks are already gone', () => {
  const message = interruptMessage('delete')
  assert.match(message, /already gone/)
  assert.match(message, /again/)
})
