# telstore

A CLI that splits large files into chunks, uploads them to Telegram over MTProto,
and restores them byte-for-byte.

## Language

**This project is English-only.** Code, comments, user-facing strings, test names,
documentation and commit messages are all written in English.

## Commands

```bash
npm test        # node --test over test/**/*.test.js
```

No build step, no linter. `npm test` is the whole gate.

## Constraints

- Node 18+, pure ESM, no TypeScript, no transpilation.
- Exactly one runtime dependency: `teleproto` (the maintained fork of the deprecated
  GramJS; same session string format, so nobody logs in again). A second one needs a
  reason that survives scrutiny.
- Tests use the built-in `node:test` runner only.
- Style: no semicolons, single quotes, two-space indent.

## The rule everything else serves

**Never produce wrong data silently.** A backup that cannot be restored must fail
loudly at upload time; a restore that cannot reproduce the original bytes must fail
rather than hand over a plausible-looking file. These checks exist purely for that and
must not be relaxed to make a test pass.

### Data integrity

- `parseManifest` validates the chunk *layout*, not just the total size — a correct sum
  with individually wrong chunk sizes yields a file with a hole while every per-chunk
  sha256 still matches.
- `runUpload` re-stats the source after the last chunk and refuses to send the manifest
  if size or mtime moved: a file rewritten mid-upload gives a self-consistent manifest
  for a hybrid that never existed.
- `runRestore` writes `<target>.partial`, verifies every chunk's size and sha256 plus the
  final length, and renames only after all of it passes.
- Manifests and state files are both untrusted input (one from a chat, one from disk a
  truncated write or hand edit can mangle). `parseManifest` and `planChunks` reject
  anything that is not a whole number of bytes rather than doing arithmetic on it: a
  string or null does not throw, it rejects for the wrong reason or spins a loop that
  never advances until memory runs out.
- `~/.telstore/config.json` is hand-editable, so it gets the same treatment: a stored
  value is parsed through the same function as the flag, and a `settings` that is not an
  object is named rather than stepped over — otherwise telstore runs on defaults while
  the user's own choices sit there ignored.
- The local record is the only pointer to chunks in the chat, so `runUpload` refuses a
  `--chunk-size` that differs from the unfinished backup's own rather than starting over,
  and `pruneStates` (keeps `MAX_STATES` most recent) names on stderr every id it drops,
  even when the caller asked for silence.

### Stalls are failures too

- `src/stall.js` gives every network wait 60 seconds of silence before it counts as an
  error. A server that accepts a request and answers nothing leaves `withRetry` no failure
  to see. The timer is deliberately not `unref`'d — it is also what keeps the event loop
  from running dry and exiting without a word.
- Measured per part, never per slice: a link delivering slowly is a link that works, and
  killing it would turn a slow restore into a failed one. One 512KB part slower than 60s
  means under 8KB/s, which could not finish a multi-gigabyte transfer anyway.
- teleproto closes the other half (`connect()` throws once its attempts are spent, and
  `_reconnect()` rejects every pending request), but the deadline stays: the library was
  never the only road to a transfer that stops without failing.

### Session tokens

- A token arrives through a chat, so `checkTokenBundle` runs on **both** sides — refusing a
  broken bundle on the machine that can fix it rather than the one that cannot.
- `Buffer.from(s, 'base64url')` **silently drops characters outside the alphabet**
  (`'abc!!!def'` → four bytes → `'abcdeQ'`). Re-encoding and comparing is what turns "wrong
  passphrase" into "this was damaged on the way here".
- AES-GCM **cannot tell a wrong key from altered bytes**; both are one failed tag check. The
  message names both, likelier first, and says telstore will not guess.
- scrypt parameters are pinned to the `tls1.` prefix, never carried inside the token: an
  embedded `N` of 2^30 is a denial of service needing no passphrase. `maxmem` is spelled out
  because Node's 32MB default would refuse `N = 2^16` as an error that reads like our bug.
- The passphrase is NFC-normalized on both sides: macOS and Linux spell the same accented
  passphrase with different bytes, and the other spelling is simply a different key.
- An empty passphrase produces `tls0.`, a genuinely different format, and `login` writes the
  ordinary plaintext config. **The config never lies about whether the secret is protected.**
  A config holding both `sealed` and a plain `session` is refused: two sources of truth for
  one account, nothing to say which was meant.

### `delete`

The one command that destroys data on purpose, so the rule runs the other way: nothing
removed that the user did not ask for, nothing reported gone that is still there.

- Chunks first, manifest last, local record last of all — the manifest is the only list of
  message ids, so removing it first strands every remaining chunk unnamed. Leaving it until
  last means an interrupted delete finishes by running the command again (Telegram says
  nothing about an id already gone). The cost is a window where `list` shows a backup
  `restore` will refuse: loud and fixable, the trade this project always takes.
- `delete` does not go through `parseManifest` — a manifest failing layout checks is exactly
  the broken backup somebody is removing, and refusing to read it leaves the only way out
  through the Telegram app. `manifestMessageIds` checks the one field `parseManifest` never
  does: a `msgId` that is not a whole positive number refuses the *whole* manifest, because a
  message id names something about to be destroyed for good. A manifest whose body names a
  different backup is refused for the same reason.
- `src/client.js` batches ids itself: teleproto's `deleteMessages` splits them into hundreds
  and fires every batch through `Promise.all` — a hundred requests in flight under neither
  `withRetry` nor the stall deadline. Its peer resolution and its choice between
  `channels.DeleteMessages` and `messages.DeleteMessages` are still what telstore calls,
  because that choice is what a fake client would never catch us getting wrong.

## Module boundaries

- `src/uploader.js` and `src/downloader.js` know byte ranges and Telegram's part APIs; they
  must not mention CLI flags like `--chunk-size` in their errors.
- `runUploads` is what `telstore a b c` runs; `runUpload` is still one file and knows nothing
  about batches. The batch shares one connection by wrapping the `connect`/`disconnect` deps
  rather than opening a client itself, so `runUpload` stays the only caller of `connect`. One
  file short-circuits straight to `runUpload` — same lines, same thrown error, no summary. What
  can be known before the first byte goes out is settled up front (a duplicate name, a missing
  path, no login, no destination): those refuse the whole batch, because a typo in the fourth
  name surfacing an hour into the third file is the same silent waste as `route` dropping the
  argument, which is what this replaced. What only the transfer can discover is per file — it is
  named on stderr the moment it happens, again in the summary, and carried out as exit code 1.
  Ctrl-C mid-batch is the one place the old wording turned into a lie: the finished files have
  had their records cleared, so `interruptMessage` names them and asks for the files that are
  left instead of "the same command again".
- `src/downloader.js` fetches a chunk as 8MB slices through a pool of concurrent
  `iterDownload` streams — one stream is one request at a time, capping a restore at
  round-trip latency (~3 MB/s). Bytes land out of order, so the chunk's sha256 is taken by
  reading the assembled range back off disk. That check is about assembly, not media: the
  read may be served from the page cache.
- `src/commands/*.js` own the user-facing narrative. `caption.js`, `chat.js`, `chunking.js`,
  `manifest.js`, `progress.js`, `retry.js`, `settings.js`, `stall.js`, `state.js`, `token.js`,
  `session.js`, `config.js` are pure enough to test without a client.
- `connect` in `src/client.js` is the one door a session goes through, which is why opening a
  sealed one lives there and not in eight (soon nine) commands. `src/session.js` holds what
  knows both config shapes — `unlockConfig` and `assertLoggedIn` — so `client.js` stays about
  Telegram; `assertLoggedIn` beside `connect` was why `token` loaded all of teleproto.
- `src/confirm.js` holds the y/N prompt `restore` and `delete` share, and
  `findManifestMessage` lives in `src/client.js` rather than either command — two copies of
  "how telstore finds a manifest" is how they start disagreeing about which file it is.
- `bin/telstore.js` imports each command inside its own `switch` arm. Nine static imports made
  every run pay for teleproto (~0.4s, 50MB) including `--help`, `config`, `logout` and `token`;
  those now start in 0.06s. `src/cli.js` stays static because every run parses arguments.
  Nothing in the suite would notice a static import creeping back, so `test/bin.test.js` runs
  the binary under `NODE_V8_COVERAGE` and counts executed teleproto scripts — must be zero.
- `src/settings.js` is the one place that knows a setting exists: flag, default, parsing,
  printing. Precedence is flag, stored setting, built-in default; **flags never write**, and
  `config` is the only thing that does. Two definitions of a default is how `config` starts
  lying about what will actually happen.
- Three flags have no setting behind them, none of them a preference: `--out` names where one
  restore goes, `--yes` answers a question about one particular backup (stored, it would be
  standing permission never to ask before destroying one), and `--token` takes **no value** —
  a token on the command line sits in `ps` and in shell history, so it is pasted at a prompt
  that does not echo. `login` refuses a positional argument rather than ignoring one.
- The `--chunk-size` refusal keys off the *source* of the size, not its presence: a config
  `chunkSize` says what to use when nobody asks, so a resumed backup keeps its own size; only
  the flag is somebody asking. `resolveSettings` returns `source(key)` for this, and throws on
  an unknown key rather than returning `undefined` — a typo would turn the refusal into a
  silent resume at the wrong size.
- Upload and download carry separate concurrency: upload counts 512KB parts, download counts
  8MB slices, so one shared value would hold sixteen times as much in flight on a restore.
  Each slot also raises the bandwidth needed for a batch's last request to arrive inside the
  60s deadline — 32 upload slots need 2.1 Mbps, 64 need 4.4. That floor is why the upload
  default is 32 and not the 64 that measured marginally faster: a slow link must never be told
  it stalled. `src/chunking.js` carries the measurements.
- Errors are reported against where the value came from: `Invalid --upload-concurrency: "0"`
  for a flag, `Invalid uploadConcurrency in ~/.telstore/config.json: "0"` for a stored one.
  Same reasoning killed *"run again without `--to`"* — useless to someone whose destination
  came from the config, so the message names the chat to pass instead. `runStatus` is the
  exception: it is run *because* something is wrong, so an unparseable setting is printed in
  its own row rather than thrown, leaving the account line and unfinished backups readable.
- `src/caption.js` owns what the chat shows. Captions are plain text — no parse mode, so no
  file name is ever escaped. `#telstore` lives on the manifest alone: `list` searches for it,
  and a chunk carrying it would turn one backup into thirteen hits.
- Commands take collaborators through a `deps` object so tests can pass fakes; keep that seam
  rather than importing the real client directly.

## What the test suite cannot see

Every automated test talks to a fake client that accepts whatever it is given, so the suite
cannot catch a mismatch with teleproto's real API surface. This has bitten twice, most
recently when the GramJS move changed `iterDownload` to `(file, params)`: 459 tests stayed
green against a call the real client refuses outright, and the time before that a published
release shipped a restore that was completely broken. Caught only by driving the real
`iterDownload` — which is what `test/downloader.test.js` now does, with the network stubbed
and nothing else.

**A fabricated error shape is the same blindness.** `test/retry.test.js` built flood errors by
hand; under GramJS every real flood error carried the literal `errorMessage` "FLOOD", so
`floodWaitSeconds` matched nothing and each `FLOOD_WAIT` was retried on the ordinary backoff —
asking again inside a running ban, which is how a ban gets longer. teleproto's
`RPCMessageToError` keeps the server's string, and `floodWaitSeconds` reads the code and the
seconds rather than the spelling. `test/smoke-import.test.js` holds the two together with an
error built the way `MTProtoSender` builds one.

**Terminals too.** `src/prompt.js` first opened a readline per question and passed against a
fake stream; a real pty does not take turns — the first interface keeps the listener, so a
second question reads nothing and reports Ctrl-D. One interface asks every question, with a
curtain in front of its output, and `terminal` follows `stdin.isTTY` (that flag is what stops
the tty driver echoing, leaving the curtain as the only thing between keyboard and screen).
The curtain also draws the mask, because a prompt showing nothing reads as the hang this
project refuses everywhere: the count comes from `rl.line`, the public property — overriding
`_writeToOutput` looks right and is not, since Node's internals have called a symbol-keyed
method since well before 22. One asterisk per character, capped to the question's line with a
trailing `…`; the cap is load-bearing, since the redraw is `\x1b[2K\r` plus the whole line and
a wrapped mask would leave stale asterisks on the rows above.

Verify any prompt change under a real pty, pacing input like a human — lines arriving before
the prompt exists are echoed by the tty and dropped, which looks exactly like a bug and is not:

```bash
( sleep 1.5; echo secret ) | script -qec "node bin/telstore.js token" /dev/null
```

Check asterisks appear as the line is typed, come back when a character is erased, and that
the secret never does.

When you touch code that hands an object to teleproto, assert against teleproto's own helper
(as `test/downloader.test.js` does with `getFileInfo` and `iterDownload`) rather than the fake,
and exercise both threshold branches against a real account before releasing: upload and
restore a file large enough to need several chunks above 10MB, plus one below it, comparing
sha256 both ways.

## Telegram limits worth remembering

- 512KB parts, at most 4000 per file → a ceiling near 1953MB, so `MAX_CHUNK_SIZE` is 1950MB
  and the default chunk is 1800MB.
- `MAX_CHUNKS` is 10000, counted **before** the plan is built. Every chunk is one message and
  one manifest entry, so a longer plan describes a backup nobody could use — and the only way
  to ask for one is a chunk size picked by mistake, where building it first would mean an
  out-of-memory crash instead of an answer.
- Above 10MB: `SaveBigFilePart` / `InputFileBig`; at or below: `SaveFilePart` / `InputFile`.
  Both branches need real-account coverage.
- `FLOOD_WAIT` is honoured for exactly the seconds the server asks for.
- `src/retry.js` governs upload and download alike: 8 attempts, exponential branch capped at
  30s (past that, doubling buys nothing — the far side has recovered or is not coming back —
  and an uncapped eighth attempt means a two-minute stare at a frozen bar). `FLOOD_WAIT` is
  the one exception to the cap: waited out in full, because guessing short just draws another.
  The backoff totals 91s (1+2+4+8+16+30+30), and with up to a minute of stall deadline on each
  of the eight attempts an outage of roughly nine minutes is survived — announced once a
  minute throughout, so it never reads as a hang — before failing loudly.
- Retries are announced from the third onward: a multi-gigabyte transfer throws off a handful
  of `-503`s that recover on the next try, and one line apiece buries the progress bar. Two
  exceptions are announced immediately — a wait over a minute, and an attempt that itself took
  over a minute to fail, which has already left the bar frozen and reads exactly like the hang
  `src/stall.js` exists to end. `withRetry` passes `onRetry` the attempt's own duration so the
  commands can tell those apart.
