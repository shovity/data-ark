import test from 'node:test'
import assert from 'node:assert/strict'

import { HELP, route, interruptMessage } from '../src/cli.js'

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

test('every file named after the first is kept, not dropped', () => {
  const r = route(['a.tar', 'b.tar', 'c.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['a.tar', 'b.tar', 'c.tar'])
})

test('flags around several files are still parsed as flags', () => {
  const r = route(['a.tar', '--to', '@store', 'b.tar'])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['a.tar', 'b.tar'])
  assert.equal(r.options.to, '@store')
})

test('restore is recognised as a subcommand with a backup id', () => {
  const r = route(['restore', 'telstore-20260905-7f3a91'])
  assert.equal(r.command, 'restore')
  assert.deepEqual(r.args, ['telstore-20260905-7f3a91'])
})

test('login and logout are subcommands', () => {
  assert.equal(route(['login']).command, 'login')
  assert.equal(route(['logout']).command, 'logout')
})

test('no arguments shows the help', () => {
  assert.equal(route([]).command, 'help')
})

test('the accompanying flags are parsed', () => {
  const r = route([
    'data.tar',
    '--to',
    '@my_backups',
    '--chunk-size',
    '1.8GB',
    '--upload-concurrency',
    '4',
    '--download-concurrency',
    '2',
  ])
  assert.equal(r.command, 'upload')
  assert.deepEqual(r.args, ['data.tar'])
  assert.equal(r.options.to, '@my_backups')
  assert.equal(r.options['chunk-size'], '1.8GB')
  assert.equal(r.options['upload-concurrency'], '4')
  assert.equal(r.options['download-concurrency'], '2')
})

test('the --out flag belongs to restore', () => {
  const r = route(['restore', 'telstore-1', '--out', '/tmp/out.tar'])
  assert.equal(r.command, 'restore')
  assert.equal(r.options.out, '/tmp/out.tar')
})

test('an invalid flag produces a clear error', () => {
  assert.throws(() => route(['data.tar', '--does-not-exist']), /--does-not-exist/)
})

test('--verbose is parsed as a flag', () => {
  assert.equal(route(['big.iso', '--verbose']).options.verbose, true)
  assert.equal(route(['big.iso']).options.verbose, undefined)
  assert.equal(route(['restore', 'telstore-1', '--verbose']).options.verbose, true)
})

test('a negative channel id is accepted separated by a space, not only with =', () => {
  assert.equal(route(['data.tar', '--to', '-1001234567890']).options.to, '-1001234567890')
  assert.equal(route(['data.tar', '--to=-1001234567890']).options.to, '-1001234567890')
  assert.equal(route(['restore', 'telstore-1', '--to', '-100123']).options.to, '-100123')
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
  assert.throws(() => route(['--to', '@my_backups']), /telstore config chat @my_backups/)
  assert.throws(() => route(['--to', '-1001234567890']), /telstore config chat -1001234567890/)
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
  const message = interruptMessage('upload', { backupId: 'telstore-20260905-7f3a91' })

  assert.match(message, /telstore-20260905-7f3a91/)
  assert.match(message, /run the same command again/)
  assert.match(message, /telstore status/)
})

test('interrupting an upload before it has an id still promises nothing false', () => {
  const message = interruptMessage('upload')

  assert.match(message, /run the same command again/)
  assert.doesNotMatch(message, /undefined/)
})

test('interrupting a batch names the backups already finished', () => {
  const message = interruptMessage('upload', {
    backupId: 'telstore-20260905-7f3a91',
    done: [
      { path: '/backups/a.tar', id: 'telstore-20260905-aaaaaa' },
      { path: '/backups/b.tar', id: 'telstore-20260905-bbbbbb' },
    ],
  })

  assert.match(message, /telstore-20260905-7f3a91/)
  assert.match(message, /a\.tar\s+telstore-20260905-aaaaaa/)
  assert.match(message, /b\.tar\s+telstore-20260905-bbbbbb/)

  // Running the whole command again would upload the finished files a second time, so the
  // line that says to do exactly that must not survive into a batch.
  assert.doesNotMatch(message, /run the same command again/)
  assert.match(message, /files that are left/)
  assert.match(message, /telstore status/)
})

test('a batch that has finished nothing yet reads exactly like a single upload', () => {
  const one = interruptMessage('upload', { backupId: 'telstore-20260905-7f3a91' })
  const batch = interruptMessage('upload', { backupId: 'telstore-20260905-7f3a91', done: [] })

  assert.equal(batch, one)
})

test('interrupting a restore says the download is lost', () => {
  assert.match(interruptMessage('restore'), /starts over/)
})

test('interrupting anything else just says it stopped', () => {
  assert.equal(interruptMessage('login'), '\nStopped.\n')
  assert.equal(interruptMessage(null), '\nStopped.\n')
})

test('delete is a subcommand carrying the backup id', () => {
  const r = route(['delete', 'telstore-20260905-7f3a91'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, ['telstore-20260905-7f3a91'])
})

test('delete without an id is still routed, so the command can say what is missing', () => {
  const r = route(['delete'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, [])
})

test('--yes is a flag, present only when it was typed', () => {
  assert.equal(route(['delete', 'telstore-1', '--yes']).options.yes, true)
  assert.equal(route(['delete', 'telstore-1']).options.yes, undefined)
})

test('delete reaches a negative channel id like every other command', () => {
  const r = route(['delete', 'telstore-1', '--to', '-1001234567890'])
  assert.equal(r.command, 'delete')
  assert.deepEqual(r.args, ['telstore-1'])
  assert.equal(r.options.to, '-1001234567890')
})

// Ctrl-C during a delete has already destroyed messages for good, and the manifest is
// deliberately still there. Saying "Stopped." alone would read as "nothing happened".
test('Ctrl-C during a delete says some chunks are already gone', () => {
  const message = interruptMessage('delete')
  assert.match(message, /already gone/)
  assert.match(message, /again/)
})

test('token routes as a command, not as a file to upload', () => {
  const r = route(['token'])
  assert.equal(r.command, 'token')
  assert.deepEqual(r.args, [])
})

// A flag carrying the token would sit in `ps` for the whole life of the command and stay in
// the shell history of a machine the user does not trust. It takes no value on purpose.
test('--token takes no value', () => {
  const r = route(['login', '--token'])
  assert.equal(r.command, 'login')
  assert.equal(r.options.token, true)
  // A token typed after the flag lands as a positional rather than being eaten by it, which
  // is what lets runLogin refuse it by name instead of ignoring it while it sits in the
  // history of a machine the user does not trust.
  assert.deepEqual(route(['login', '--token', 'tls1.abc']).args, ['tls1.abc'])
})

// A note with spaces in it reaches telstore as one argument only because the shell was told
// to keep it whole. Both spellings do that, and both have to arrive here identically.
test('a quoted note arrives whole whichever way it was written', () => {
  assert.equal(route(['a.tar', '--note', 'quarterly accounts']).options.note, 'quarterly accounts')
  assert.equal(route(['a.tar', '--note=quarterly accounts']).options.note, 'quarterly accounts')
})

// The failure this flag invites: an unquoted note, whose remaining words the shell hands over
// as separate arguments and route can only read as more files to upload. Nothing here can fix
// that — the words are gone by the time node starts — but the shape has to stay predictable
// so the command that gets them can say what happened.
test('an unquoted note leaves its remaining words as positionals', () => {
  const r = route(['a.tar', '--note', 'quarterly', 'accounts'])

  assert.equal(r.options.note, 'quarterly')
  assert.deepEqual(r.args, ['a.tar', 'accounts'])
})

// A flag the parser accepts and the help never mentions is a feature only its author knows
// about. This is the one test that notices when the two drift apart.
test('every flag the parser accepts is named in the help', () => {
  for (const flag of ['to', 'chunk-size', 'upload-concurrency', 'download-concurrency', 'out',
    'note', 'limit', 'verbose', 'unset', 'yes', 'token', 'help']) {
    assert.ok(HELP.includes(`--${flag}`), `--${flag} is missing from the help`)
  }
})

// `--note ghi chu` and `--note "ghi chu"` look the same by the time node starts, with one
// exception: the unquoted one leaves its own tail sitting after the flag as positionals.
// That position is the only evidence there is, so route is where it gets written down.
test('route notices a file named after --note', () => {
  assert.equal(route(['a.tar', '--note', 'ghi', 'chu']).filesAfterNote, true)
  assert.equal(route(['--note=ghi', 'chu']).filesAfterNote, true)
})

test('route reports no file after a note the shell kept whole', () => {
  assert.equal(route(['a.tar', '--note', 'ghi chu']).filesAfterNote, false)
  assert.equal(route(['not-found', '--note', 'march']).filesAfterNote, false)
  assert.equal(route(['a.tar']).filesAfterNote, false)
})
