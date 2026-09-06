# data-ark

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

The same rule covers the local record of a backup, because losing it strands chunks in the
chat that nothing can point at any more: `runUpload` refuses a `--chunk-size` that differs
from the unfinished backup's own (and resumes at that size when the flag is absent) rather
than starting over, and `pruneStates` — which keeps only the `MAX_STATES` most recent
records — names on stderr every backup id it drops, even when the caller asked for silence.

## Module boundaries

`src/uploader.js` and `src/downloader.js` know about byte ranges and Telegram's
part APIs; they must not mention CLI flags like `--chunk-size` in their errors.

`src/downloader.js` fetches a chunk as 8MB slices through a pool of concurrent
`iterDownload` streams, because one stream is one request at a time and that caps a restore
at round-trip latency — about 3 MB/s — however much bandwidth is going spare. Bytes
therefore land out of order, so the chunk's sha256 is taken by reading the assembled range
back off disk once every slice is in. That check is about assembly, not media: the read may
be served from the page cache.

`src/commands/*.js` own the user-facing narrative. `src/caption.js`,
`src/chunking.js`, `src/manifest.js`, `src/progress.js`, `src/retry.js`,
`src/stall.js`, `src/state.js` and `src/config.js` are pure enough to test without a client.

`src/caption.js` also owns the shape of what the chat shows. Captions are plain text:
no parse mode, so no file name ever has to be escaped. The `#dataark` tag lives on the
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
- Files above 10MB must use `SaveBigFilePart` / `InputFileBig`; at or below that,
  `SaveFilePart` / `InputFile`. Both branches need real-account coverage.
- `FLOOD_WAIT` is honoured for exactly the seconds the server asks for, and any
  wait over a minute is announced so the user does not read it as a hang.
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
