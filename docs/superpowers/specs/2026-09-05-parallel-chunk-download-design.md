# Parallel chunk download

Status: approved, not yet implemented
Date: 2026-09-05

## The problem

Restoring a 4.3GB backup takes about 24 minutes and the whole time is spent
waiting, not transferring.

`downloadToFile` pulls a chunk through a single `client.iterDownload` stream.
That stream issues one `upload.GetFile` at a time and awaits each before asking
for the next, so throughput is capped by round-trip latency rather than by
bandwidth: 512KB per request at ~175ms per request is ~2.9 MB/s, whatever the
link underneath can actually carry.

Measured on two different machines and networks:

| | sequential | 8 parallel | 16 parallel | 24 parallel |
|---|---|---|---|---|
| N `iterDownload` streams | 3.32 MB/s | 18.86 | 18.25 | — |
| own `GetFile` loop | 3.18–3.29 | 16.3–19.4 | 14.6–22.0 | 21.92 |

A separate machine running the released CLI over a different network reported
3.1 MB/s — the same number, because both are bounded by the same round trip.
Parallelism is worth 5–7x, and it plateaus at 8; 16 is no better and 24 is no
better than 16.

### What sustained transfer actually measured (2026-09-06)

The numbers above are what shipped, and they are optimistic. Every one of them
comes from a burst of 1.5–3.5 seconds. A real restore runs for minutes, and the
implementation measured against the same 4.3GB backup sustains **9.7 MB/s**, not
19 — a genuine 3.1x over the 3.1 MB/s that motivated this work, but half the
speedup this design claimed. A 4.3GB restore lands around 7–8 minutes rather
than the ~4 predicted above.

The disk was ruled out: `dd` writes sequentially at 256 MB/s on the same
machine. The likeliest explanation is that Telegram throttles a sustained
multi-minute transfer more than it throttles short bursts, which the benchmark
never sampled. Anyone benchmarking this path again should measure over minutes,
not seconds.

## Approach

Split each chunk into fixed 8MB slices and run a pool of 8 workers that pull
slices off a queue. Each slice is downloaded by its own short `iterDownload`
stream.

The rejected alternative was to drive `upload.GetFile` directly, which would
give retry granularity of a single 512KB part and mirror `uploader.js` exactly.
It measures the same speed, and it costs more: `FileMigrateError` is handled
only inside `iterDownload` (`node_modules/telegram/client/downloads.js:120`) and
not in `client.invoke`, so driving requests ourselves means reimplementing DC
migration — precisely the kind of GramJS-surface code this project's test suite
cannot see, and precisely how restore shipped broken once before.

Keeping `iterDownload` keeps DC selection, sender management and
`FileMigrateError` where they already work.

225 slices against 8 workers means the pool self-balances and a single failing
slice risks only 8MB of work.

## Interface

`downloadToFile(client, message, fd, { offset, onProgress, retryOptions })`
returning `{ sha256, size }` is unchanged, so `src/commands/restore.js` needs no
edit at all. The parallelism lives entirely behind that call.

Chunk length comes from Telegram's own `document.size`, never from the caller.
Accepting a size from the caller would make `runRestore`'s `size !== chunk.size`
check compare the manifest against itself; reading it off the document keeps
that comparison between two independent sources.

## Downloading a slice

```js
let done = 0                       // bytes of this slice already written
await withRetry(async () => {
  for await (const buf of client.iterDownload({
    file: message.media,
    offset: returnBigInt(sliceStart + done),   // offset inside the document
    requestSize: PART_SIZE,
  })) {
    const take = Math.min(buf.length, sliceLength - done)
    await writeExactly(fd, buf.subarray(0, take), offset + sliceStart + done)
    done += take
    onProgress?.(take)
    if (done >= sliceLength) break
  }
}, retryOptions)
```

`done` lives outside `withRetry`, so a retried slice resumes at its own
watermark and `onProgress` never counts a byte twice.

Two offsets are in play and must not be confused: `sliceStart + done` is a
position inside the document, and `offset + sliceStart + done` is a position
inside the file being assembled.

The stream runs to the end of the document, so each slice stops itself at its
boundary via `take`.

`progress.advance` is synchronous (`done += bytes`, no await), so concurrent
workers accumulate correctly with no change to `src/progress.js`.

## Hashing

Bytes now arrive out of order, so the digest can no longer be built as they are
written. Once every slice is done, the chunk is read back sequentially from the
`.partial` file through the same open `fd`, in 4MB reads, and hashed then.

This validates assembly: a slice written at the wrong offset, two slices
overlapping, a slice silently skipped, a short write, an arithmetic slip in
`take`/`done`. Those are exactly the failure modes parallel writing introduces.

It does not prove the bytes reached the physical disk — the read may be served
from the page cache, and proving otherwise would need `fsync` plus `O_DIRECT`.
The check is about assembly, not media integrity, and should be described that
way.

`downloader.js` gets its own local `readExactly`, symmetric with the
`writeExactly` already there. It duplicates ten lines from `uploader.js`;
extracting a shared module for one small primitive costs more than it saves.

## Retry

Two changes in `src/retry.js`, both of which also make uploads more resilient:

- Cap the exponential branch at 30s. The cap applies only to that branch —
  `FLOOD_WAIT` continues to wait exactly the seconds the server asks for,
  because retrying a flood wait early earns a longer one.
- Raise the default from 5 attempts to 8. The waits become 1, 2, 4, 8, 16, 30,
  30 — 91 seconds of tolerated dead air instead of today's 15, which is what a
  brief network outage or DC hiccup actually needs.

The outer progress-reset loop in `downloadToFile` is deleted. Its purpose was to
grant a fresh budget after forward progress, and it never worked as its comment
claimed: `withRetry` counts attempts internally, so the budget only reset after
all five were spent. Per-slice retry makes the whole question moot, the same way
per-part retry already does for upload.

A slice that exhausts its budget fails the chunk, as today, and the `.partial`
file is kept for inspection.

## When one worker fails and seven are still running

`uploadRange` already learned this lesson and the download pool must follow it:
a promise that rejects while nobody is awaiting it yet becomes an
`unhandledRejection` that hides the real error, so every worker attaches its own
handler at creation rather than relying on a `Promise.all` at the end
(`src/uploader.js:88-105`).

The pool stops handing out new slices as soon as any worker fails, then waits
for the workers already in flight to settle before throwing. Waiting matters:
returning while requests are still running would let a write land in `fd` after
`runRestore` has moved on, and the first error seen is the one thrown — later
failures caused by the shutdown must not replace it.

The digest is computed only if every slice succeeded. A chunk that failed is
never hashed and never compared, because a partial chunk has no meaningful
sha256.

## Out of scope

No `--concurrency` flag for `restore`. The measurements put 8 and 16 within
noise of each other and 24 no better, so there is no evidence anyone needs the
knob, and adding one costs validation, an error message, documentation and
tests. Easy to add later if a slower or higher-latency link turns out to want it.

## Testing

Against the fake client:

- assembled bytes equal the source, and the reported sha256 matches
- every byte is covered exactly once — no gap, no overlap — checked with a
  per-position marker rather than by total length alone
- a final slice shorter than 8MB, and a chunk size that is not a multiple of
  `PART_SIZE`
- a slice that fails once resumes at its watermark, and `onProgress` still sums
  to exactly the chunk size
- a slice that never succeeds fails the whole download

Against GramJS itself, as `CLAUDE.md` requires — the fake accepts anything, so
these must ask the real thing:

- the offset handed to `iterDownload` for a mid-document slice is a big-integer
  its real `iterDownload` accepts (extend the existing test)
- what we pass still casts to an `InputDocumentFileLocation`

Before release, and not visible to any automated test: restore a real
multi-chunk file above 10MB and one below it from a real account, comparing
sha256 in both directions. Interrupting the network mid-restore to force a slice
resume is worth doing while there.

## Files

- `src/downloader.js` — the rewrite
- `src/retry.js` — delay cap, attempt default
- `src/chunking.js` — `SLICE_SIZE` beside `PART_SIZE`
- `src/commands/restore.js` — unchanged
- `test/downloader.test.js`, `test/retry.test.js` — new coverage
- `CLAUDE.md` — record the new shape of the download path
