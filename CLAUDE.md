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

There is no build step and no linter. `npm test` is the whole gate.

## Constraints

- Node 18+, pure ESM, no TypeScript, no transpilation.
- Exactly one runtime dependency: `telegram` (GramJS). Adding a second one needs
  a reason that survives scrutiny.
- Tests use the built-in `node:test` runner only.
- Style follows the existing files: no semicolons, single quotes, two-space indent.

## The rule everything else serves

**Never produce wrong data silently.** A backup that cannot be restored must fail
loudly at upload time; a restore that cannot reproduce the original bytes must
fail rather than hand over a plausible-looking file. Several checks exist purely
for this and must not be relaxed to make a test pass:

- `parseManifest` validates the chunk *layout*, not just the total size — a correct
  sum with individually wrong chunk sizes yields a file with a hole while every
  per-chunk sha256 still matches.
- `runUpload` re-stats the source file after the last chunk and refuses to send the
  manifest if size or mtime moved, because a file rewritten mid-upload produces a
  self-consistent manifest for a hybrid that never existed.
- `runRestore` writes to `<target>.partial`, verifies every chunk's size and sha256
  plus the final file length, and renames only after all of it passes.

The rule also covers a transfer that stops without failing. GramJS can leave a request on a
sender it has quietly given up reconnecting, and that promise never settles either way: its
own abort path is unreachable (`MTProtoSender` rejects pending states only when
`_currentRetries > _reconnectRetries`, and `reconnectRetries` has no default to compare
against), and `_reconnect()` treats a `connect()` that merely returned false as success. A
real network cut mid-restore was reproduced this way: on Linux the transfer froze for eleven
minutes and then recovered, on Windows the process ended mid-chunk without printing a line.
`src/stall.js` is what makes that impossible — every network wait carries a 60-second
deadline, so silence becomes an error `withRetry` can announce and act on. Its timer is
deliberately not `unref`'d: it is the handle that keeps the event loop from running dry and
exiting without a word.

Manifests and state files are both untrusted input — one is downloaded from a chat, the
other is JSON on disk that a truncated write or a hand edit can mangle — so neither is
believed before its numbers are checked. `parseManifest` and `planChunks` reject anything
that is not a whole number of bytes rather than doing arithmetic on it: a string or a null
does not throw, it produces a comparison that rejects for the wrong reason, or a loop that
never advances and spins until the process runs out of memory.

The same rule covers the local record of a backup, because losing it strands chunks in the
chat that nothing can point at any more: `runUpload` refuses a `--chunk-size` that differs
from the unfinished backup's own rather than starting over, and `pruneStates` — which keeps
only the `MAX_STATES` most recent records — names on stderr every backup id it drops, even
when the caller asked for silence.

`delete` is the one command that destroys data on purpose, so the rule runs the other way
for it: nothing may be removed that the user did not ask for, and nothing may be reported
gone that is still there. Three things follow, and none of them is decoration.

The chunks go first and the manifest goes last, because the manifest is the only list of the
message ids. Removing it first and then losing the connection strands every remaining chunk
with nothing able to name it again — exactly the mess `delete` exists to clean up. Leaving it
until last means an interrupted delete is finished by running the same command again, since
Telegram says nothing about an id that is already gone. The visible cost is a window where
`list` still shows a backup that `restore` will refuse: loud and fixable, which is the trade
this project always takes. The local record goes last of all, after the chat is clean, for
the same reason — where there is no manifest it *is* the only list.

`delete` does not go through `parseManifest`. That function validates the chunk *layout*
because `restore` writes bytes at offsets computed from it, and a manifest that fails those
checks is precisely the broken backup somebody is trying to remove; refusing to read it would
leave the only way out through the Telegram app. What `delete` needs instead is the one field
`parseManifest` never checks, so `manifestMessageIds` checks it and nothing else: a `msgId`
that is not a whole positive number refuses the *whole* manifest rather than deleting the ids
around it, because a message id is the name of something about to be destroyed for good, and
that is the one number nobody may guess at. A manifest whose body names a different backup is
refused for the same reason — a file renamed in the chat would otherwise have telstore destroy
another backup's chunks while reporting this one.

`src/client.js` batches the ids itself rather than handing all of them to GramJS at once.
GramJS's `deleteMessages` splits them into hundreds and fires every batch through
`Promise.all`, which would put a hundred requests in flight with none of them under
`withRetry` or the stall deadline. Its peer resolution and its choice between
`channels.DeleteMessages` and `messages.DeleteMessages` are still what telstore calls, because
that choice is exactly what a fake client would never catch us getting wrong.

That refusal keys off the *source* of the size, not its presence. A `chunkSize` in the config
file says what to use when nobody asks for anything, so a resumed backup quietly keeps its own
size; only `--chunk-size` on the command line is somebody asking, and only that is refused.
`resolveSettings` returns a `source(key)` for exactly this, and it throws on a key it does not
know rather than returning `undefined` — a typo there would turn the refusal into a silent
resume at the wrong size. `~/.telstore/config.json` is hand-editable now that `config` invites
people into it, so it belongs with the manifests and state files above: a stored value is
parsed through the same function as the flag, and a `settings` that is not an object is named
rather than stepped over, because every lookup below it would otherwise return `undefined` and
telstore would run on defaults while the user's own choices sat there ignored.

## Module boundaries

`src/uploader.js` and `src/downloader.js` know about byte ranges and Telegram's
part APIs; they must not mention CLI flags like `--chunk-size` in their errors.

`src/downloader.js` fetches a chunk as 8MB slices through a pool of concurrent
`iterDownload` streams, because one stream is one request at a time and that caps a restore
at round-trip latency — about 3 MB/s — however much bandwidth is going spare. Bytes
therefore land out of order, so the chunk's sha256 is taken by reading the assembled range
back off disk once every slice is in. That check is about assembly, not media: the read may
be served from the page cache.

`src/commands/*.js` own the user-facing narrative. `src/caption.js`, `src/chat.js`,
`src/chunking.js`, `src/manifest.js`, `src/progress.js`, `src/retry.js`, `src/settings.js`,
`src/stall.js`, `src/state.js` and `src/config.js` are pure enough to test without a client.

`src/confirm.js` holds the y/N prompt `restore` and `delete` both ask through, and
`findManifestMessage` lives in `src/client.js` rather than in either command, because two
copies of "how telstore finds a manifest" is how the two of them start disagreeing about
which file is the manifest.

`--yes` and `--out` are the two flags with no setting behind them, and for the same kind of
reason: neither is a preference. `--out` names where one restore goes, and `--yes` is the
answer to a question asked about one particular backup. Stored in the config it would become
standing permission never to ask again before destroying one.

`src/settings.js` is the one place that knows a setting exists: its flag, its default, how it
parses and how it prints. `config`, `cli.js`'s help and every command read it, so a default
has one definition rather than three — two definitions is how a `config` command starts lying
about what will actually happen. Precedence is flag, then the stored setting, then the
built-in default; **flags never write**, and the `config` command is the only thing that does.

The boundary rule extends to whose fault an error is. A value that will not parse is reported
against where it came from — `Invalid --concurrency: "0"` for a flag, `Invalid concurrency in
~/.telstore/config.json: "0"` for a stored one — because naming a flag nobody typed sends the
reader after the wrong thing. The same reasoning killed the old resume message: *"run again
without `--to`"* is no help to someone whose destination came from the config, so it names the
chat to pass instead, which is right whatever the source. `runStatus` is the exception that
proves the rule: it is what someone runs *because* something is already wrong, so a setting it
cannot parse is printed in its own row rather than thrown, leaving the account line and the
unfinished backups readable.

`src/caption.js` also owns the shape of what the chat shows. Captions are plain text:
no parse mode, so no file name ever has to be escaped. The `#telstore` tag lives on the
manifest alone — `list` searches for it, and a chunk carrying it would turn one backup
into thirteen hits.

Commands take their collaborators through a `deps` object so tests can pass fakes;
keep that seam rather than importing the real client directly.

## What the test suite cannot see

Every automated test talks to a fake client that accepts whatever it is given, so
the suite cannot catch a mismatch with GramJS's real API surface. This has bitten
once already: `downloadToFile` passed `message.media.document` where GramJS needs
`message.media`, and 142 tests stayed green while restore was completely broken in
a published release.

When you touch code that hands an object to GramJS, assert against GramJS's own
helper (as `test/downloader.test.js` does with `getFileInfo`) rather than against
the fake, and exercise both threshold branches against a real account before
releasing — upload and restore a file large enough to need several chunks above
10MB, plus one below it, and compare sha256 both ways.

## Telegram limits worth remembering

- 512KB parts, at most 4000 per file → an arithmetic ceiling near 1953MB, so
  `MAX_CHUNK_SIZE` is 1950MB and the default chunk is 1800MB.
- `MAX_CHUNKS` is 10000, counted before the plan is built. Every chunk is one message in the
  chat and one entry in the manifest, so a longer plan describes a backup nobody could use —
  and the only way to ask for one is a chunk size picked by mistake, where building it first
  would mean an out-of-memory crash instead of an answer.
- Files above 10MB must use `SaveBigFilePart` / `InputFileBig`; at or below that,
  `SaveFilePart` / `InputFile`. Both branches need real-account coverage.
- `FLOOD_WAIT` is honoured for exactly the seconds the server asks for, and any
  wait over a minute is announced so the user does not read it as a hang.
- Retries are announced from the third one onward, not the first: a multi-gigabyte transfer
  throws off a handful of `-503`s that each recover on the next try, and one line apiece
  buries the progress bar. Two exceptions are announced immediately — a wait longer than a
  minute (`FLOOD_WAIT`), and an attempt that itself took longer than a minute to fail, which
  has already left the bar frozen for that minute and so reads exactly like the hang
  `src/stall.js` exists to end. `withRetry` passes `onRetry` the failed attempt's own
  duration so the commands can tell those apart.
- A stalled request is not a failed one, and only the second is something `withRetry` can
  see. `src/stall.js` gives every network wait 60 seconds of silence before it counts as an
  error — one 512KB part slower than that means under 8KB/s, which could not finish a
  multi-gigabyte transfer anyway. Measured per part, never per slice: a link delivering
  slowly is a link that works, and killing it would turn a slow restore into a failed one.
- `src/retry.js` governs both upload and download with the same policy: 8 attempts,
  the exponential branch capped at 30s because past that point doubling again buys
  nothing — the far side has either recovered or is not coming back on this attempt,
  and an uncapped eighth attempt would mean a two-minute stare at a frozen bar.
  `FLOOD_WAIT` is the one exception to the cap: it is still waited out in full for
  exactly the seconds the server names, because guessing short would just draw
  another `FLOOD_WAIT`. The backoff itself adds up to 91 seconds (1 + 2 + 4 + 8 + 16 + 30 +
  30), and with the stall deadline spending up to a minute on each of the eight attempts an
  outage of roughly nine minutes is survived — announced once a minute throughout, so it
  never reads as a hang — before the transfer gives up and fails loudly.
