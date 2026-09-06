# Parallel Chunk Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `downloadToFile` pull a chunk through several concurrent `iterDownload` streams instead of one, turning a ~24 minute 4.3GB restore into roughly 4 minutes.

**Architecture:** Each chunk is cut into fixed 8MB slices. A pool of 8 workers pulls slices off a queue; each slice is one short `iterDownload` stream wrapped in `withRetry` that resumes at its own watermark. Because bytes then land out of order, the chunk's sha256 is computed after every slice has landed, by reading the assembled range back off disk.

**Tech Stack:** Node 18+, pure ESM, no TypeScript. One runtime dependency: `telegram` (GramJS). Tests use `node:test` only.

**Spec:** `docs/superpowers/specs/2026-09-05-parallel-chunk-download-design.md`

## Global Constraints

- **English only.** Code, comments, user-facing strings, test names, documentation and commit messages are all written in English.
- **Style:** no semicolons, single quotes, two-space indent — follow the surrounding files.
- **Exactly one runtime dependency:** `telegram`. Do not add a second. Big-integer helpers come through `telegram/Helpers.js`.
- **Tests:** built-in `node:test` runner only. `npm test` is the whole gate; there is no linter and no build step.
- **Never produce wrong data silently.** A restore that cannot reproduce the original bytes must fail rather than hand over a plausible-looking file. Do not relax an existing check to make a test pass.
- **Module boundaries:** `src/downloader.js` knows about byte ranges and Telegram's part APIs and must not mention CLI flags in its errors. `src/commands/*.js` own the user-facing narrative.
- **GramJS surface:** the fake client accepts anything, so it cannot catch a mismatch with GramJS's real API. When handing an object to GramJS, assert against GramJS's own helper, as `test/downloader.test.js` already does with `getFileInfo`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/retry.js` | one retry policy shared by upload and download | cap the exponential branch, raise the attempt default |
| `src/chunking.js` | pure size constants and planning | add `SLICE_SIZE` |
| `src/downloader.js` | byte ranges and Telegram's download API | slice planning, hash by read-back, worker pool |
| `src/commands/restore.js` | the restore narrative | **no change** — the `downloadChunk` seam is preserved |
| `src/progress.js` | the bar | **no change** — `advance` is synchronous and accumulates safely |
| `test/retry.test.js` | retry policy coverage | cap and attempt-count tests |
| `test/downloader.test.js` | downloader coverage | offset-aware fakes, slice coverage, pool failure semantics |
| `test/restore.test.js` | restore coverage | one fake needs a document size |
| `CLAUDE.md` | the project's own briefing | record the new download shape |

---

## Task 1: Widen the retry budget and stop the backoff running away

Independent of everything else, and it makes uploads more resilient too, so it lands first.

**Files:**
- Modify: `src/retry.js:1-2`, `src/retry.js:34`
- Test: `test/retry.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `withRetry(fn, { attempts = 8, baseDelayMs = 1000, sleep, onRetry })`. Exponential delays become `Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000)`. `FLOOD_WAIT` delays stay exactly `err.seconds * 1000`, uncapped.

- [ ] **Step 1: Write the failing tests**

Add to `test/retry.test.js`:

```js
test('the exponential backoff stops growing at 30 seconds', async () => {
  const delays = []

  await assert.rejects(
    () => withRetry(async () => { throw new Error('permanently broken') }, {
      attempts: 8,
      sleep: fakeSleep(delays),
    }),
    /permanently broken/,
  )

  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000])
})

test('a FLOOD_WAIT longer than the cap is still waited out in full', async () => {
  // Capping a flood wait means asking again before the server is ready, which earns a
  // longer ban. Only the exponential branch is capped.
  const delays = []
  let calls = 0

  await withRetry(
    async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('A wait of 3600 seconds is required')
        err.seconds = 3600
        err.errorMessage = 'FLOOD_WAIT'
        throw err
      }
      return 'done'
    },
    { sleep: fakeSleep(delays) },
  )

  assert.deepEqual(delays, [3600000])
})

test('a stalled stretch is given 8 attempts, about 90 seconds of dead air', async () => {
  // 15 seconds was not enough to ride out a brief outage: five attempts spent 1+2+4+8.
  let calls = 0
  const delays = []

  await assert.rejects(
    () => withRetry(async () => { calls += 1; throw new Error('broken') }, { sleep: fakeSleep(delays) }),
    /broken/,
  )

  assert.equal(calls, 8)
  assert.equal(delays.reduce((a, b) => a + b, 0), 91000)
})
```

- [ ] **Step 2: Delete the test that pins the old default**

`test/retry.test.js:53-63` is `'defaults to at most 5 attempts'` and asserts `calls === 5`. The third new test replaces it. Delete it — do not leave two tests disagreeing about the default.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"`
Expected: the three new tests fail — delays still double past 30000, and `calls` is 5 rather than 8.

- [ ] **Step 4: Implement**

In `src/retry.js`, replace the two constants at the top:

```js
const DEFAULT_ATTEMPTS = 8
const DEFAULT_BASE_DELAY_MS = 1000

// Past half a minute the doubling stops buying anything: the wait is already long enough
// that the far side has either recovered or is not coming back on this attempt. Left
// uncapped, eight attempts would end in a two-minute stare at a frozen bar.
const MAX_BACKOFF_MS = 30_000
```

and the delay line inside the catch block:

```js
      const flood = floodWaitSeconds(err)
      const delayMs =
        flood === null
          ? Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS)
          : flood * 1000
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"`
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/retry.js test/retry.test.js
git commit -m "fix: give a stalled transfer 90 seconds instead of 15

Five attempts at 1+2+4+8 seconds is 15 seconds of tolerated dead air, so a
network blip or a DC hiccup of half a minute ends a restore that has no progress
file to resume from. Eight attempts with the exponential branch capped at 30s
covers about 90 seconds instead.

The cap is on the exponential branch alone: a FLOOD_WAIT is still waited out for
exactly the seconds the server named, because asking again early earns a longer
ban."
```

---

## Task 2: Cut the chunk into slices and hash it off disk

The structural change: slice planning, per-slice retry with watermark resume, the digest taken from the assembled range, and the death of the outer progress-reset loop. Still one slice at a time, so no speed change is up for review here.

**Files:**
- Modify: `src/chunking.js`, `src/downloader.js`
- Test: `test/downloader.test.js`, `test/restore.test.js:396-425`

**Interfaces:**
- Consumes: `withRetry` from Task 1.
- Produces: `SLICE_SIZE = 8 * 1024 * 1024` exported from `src/chunking.js`. Module-private `readExactly(fd, length, position) -> Promise<Buffer>` and `hashRange(fd, offset, length) -> Promise<string>` in `src/downloader.js`. `downloadToFile(client, message, fd, { offset, onProgress, retryOptions })` keeps its signature and its `{ sha256, size }` return, but now takes the chunk length from `message.media.document.size` and throws `Message <id> has a document with no usable size.` when that is missing or not positive.

- [ ] **Step 1: Replace the test helpers with offset-aware ones**

`fakeClient(chunks)` at `test/downloader.test.js:18-28` yields a fixed list whatever offset it is asked for, so it cannot tell a correct slice offset from a wrong one. Replace both helpers at `test/downloader.test.js:14-28`:

```js
// The document is the chunk: its byte 0 is the chunk's byte 0. Callers must say how long it
// is, because downloadToFile plans its slices from that length.
function fakeMessage(size, document = { id: 'doc-1' }) {
  return { id: 999, media: { document: { ...document, size } } }
}

// The real iterDownload streams from `offset` to the end of the document. A fake that
// ignored the offset would let every slice-offset mistake through.
function fakeClient(content, { partSize = 100 } = {}) {
  return {
    calls: [],
    iterDownload(params) {
      this.calls.push(params)
      const from = Number(params.offset ?? 0)

      return (async function* () {
        for (let at = from; at < content.length; at += partSize) {
          yield content.subarray(at, at + partSize)
        }
      })()
    },
  }
}
```

Then migrate the existing call sites in that file. The rules are mechanical:

- `fakeClient([buf])` where the test built one buffer becomes `fakeClient(buf)`.
- `fakeClient([a, b])` where the test deliberately split one buffer, as at line 41, becomes `fakeClient(content, { partSize: 1000 })` — the split point becomes the part size.
- `fakeClient([Buffer.alloc(n)])` becomes `fakeClient(Buffer.alloc(n))`.
- `fakeClient([Buffer.alloc(100), Buffer.alloc(100), Buffer.alloc(100)])` at line 104 becomes `fakeClient(Buffer.alloc(300), { partSize: 100 })`, which keeps the `[100, 100, 100]` progress assertion true.
- `fakeMessage()` becomes `fakeMessage(<the content length that test uses>)`.
- `fakeMessage({ id: 'doc-abc' })` at line 67 becomes `fakeMessage(10, { id: 'doc-abc' })`.
- The `Api.Document` test at lines 76-100 already sets `size: bigInt(10)` on a real document — leave that message exactly as it is.
- `flakyClient` keeps its body; its `fakeMessage()` calls take the content length the same way.
- The two error tests at lines 113-122 and 124-133 pass a message with no document or no offset and must keep asserting the same messages.

- [ ] **Step 2: Write the failing tests**

Add `import { SLICE_SIZE } from '../src/chunking.js'` at the top of `test/downloader.test.js`, then:

```js
test('the digest and the size describe the document, not whatever the stream yielded', async () => {
  // The fake streams everything it has, but the document says it is shorter. Hashing the
  // buffers as they arrive would digest bytes that are not part of this chunk at all.
  const content = randomBytes(1000)
  const { file, handle } = await tempFd(1000)
  const client = fakeClient(content, { partSize: 250 })

  const result = await downloadToFile(client, fakeMessage(750), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(result.size, 750)
  assert.equal(result.sha256, createHash('sha256').update(content.subarray(0, 750)).digest('hex'))
  assert.deepEqual((await fs.readFile(file)).subarray(0, 750), content.subarray(0, 750))
})

test('the digest covers the chunk range only, not its neighbours in the file', async () => {
  const content = randomBytes(500)
  const { file, handle } = await tempFd(1500)
  await handle.write(Buffer.alloc(500, 0xaa), 0, 500, 0)
  await handle.write(Buffer.alloc(500, 0xbb), 0, 500, 1000)

  const client = fakeClient(content)
  const result = await downloadToFile(client, fakeMessage(500), handle.fd, { offset: 500 })

  await handle.close()
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'))

  const onDisk = await fs.readFile(file)
  assert.deepEqual(onDisk.subarray(0, 500), Buffer.alloc(500, 0xaa), 'the bytes before must survive')
  assert.deepEqual(onDisk.subarray(1000), Buffer.alloc(500, 0xbb), 'the bytes after must survive')
})

test('a chunk longer than one slice is fetched as several streams', async () => {
  const content = randomBytes(SLICE_SIZE + 1000)
  const { file, handle } = await tempFd(content.length)
  const client = fakeClient(content, { partSize: 512 * 1024 })

  const result = await downloadToFile(client, fakeMessage(content.length), handle.fd, { offset: 0 })

  await handle.close()
  assert.equal(client.calls.length, 2, 'one stream per slice')
  assert.deepEqual(client.calls.map((c) => Number(c.offset)), [0, SLICE_SIZE])
  assert.equal(result.size, content.length)
  assert.deepEqual(await fs.readFile(file), content)
})

test('every byte is covered exactly once, with no gap and no overlap', async () => {
  // Length alone cannot tell a gap from an overlap that happens to cancel it out. Give every
  // position a value derived from its own index and compare byte for byte.
  const length = SLICE_SIZE * 2 + 4096
  const content = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) content[i] = (i * 31) % 251

  const { file, handle } = await tempFd(length)
  const client = fakeClient(content, { partSize: 512 * 1024 })

  await downloadToFile(client, fakeMessage(length), handle.fd, { offset: 0 })

  await handle.close()
  assert.deepEqual(await fs.readFile(file), content)
})

test('the last slice is whatever is left, not a full slice', async () => {
  const content = randomBytes(SLICE_SIZE + 7)
  const { handle } = await tempFd(content.length)
  const client = fakeClient(content, { partSize: 512 * 1024 })
  const seen = []

  const result = await downloadToFile(client, fakeMessage(content.length), handle.fd, {
    offset: 0,
    onProgress: (n) => seen.push(n),
  })

  await handle.close()
  assert.equal(result.size, content.length)
  assert.equal(seen.reduce((a, b) => a + b, 0), content.length, 'no byte counted twice')
})

test('a slice that fails resumes at its own watermark', async () => {
  const content = randomBytes(SLICE_SIZE + 1000)
  const { file, handle } = await tempFd(content.length)
  let broken = false

  const client = {
    calls: [],
    iterDownload(params) {
      this.calls.push(params)
      const from = Number(params.offset ?? 0)
      const breakAfter = from === 0 && !broken ? ((broken = true), 2) : Infinity

      return (async function* () {
        let sent = 0
        for (let at = from; at < content.length; at += 512 * 1024) {
          if (sent === breakAfter) throw new Error('-503: Timeout (caused by upload.GetFile)')
          yield content.subarray(at, at + 512 * 1024)
          sent += 1
        }
      })()
    },
  }

  const result = await downloadToFile(client, fakeMessage(content.length), handle.fd, {
    offset: 0,
    retryOptions: { baseDelayMs: 0, sleep: async () => {} },
  })

  await handle.close()
  assert.equal(Number(client.calls[1].offset), 2 * 512 * 1024, 'it picks up where it stopped')
  assert.equal(result.size, content.length)
  assert.deepEqual(await fs.readFile(file), content)
})

test('a document with no size is refused rather than quietly downloaded as nothing', async () => {
  const { handle } = await tempFd(10)
  const client = fakeClient(randomBytes(10))

  await assert.rejects(
    () => downloadToFile(client, { id: 42, media: { document: { id: 'd' } } }, handle.fd, { offset: 0 }),
    /no usable size/,
  )
  await handle.close()
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/downloader.test.js 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: the file fails to import at all, because `SLICE_SIZE` is not exported yet. After Step 4 adds the constant, re-running shows the real failures: the first test reports `size` 1000 instead of 750 and a digest over all 1000 bytes, and the slice tests make only one `iterDownload` call.

- [ ] **Step 4: Add the constant**

In `src/chunking.js`, beside `PART_SIZE`:

```js
// One slice is one short iterDownload stream. Small enough that a failed slice costs little
// and that there are far more slices than workers for the pool to balance across; big enough
// that the per-stream setup disappears against 16 parts of payload.
export const SLICE_SIZE = 8 * 1024 * 1024
```

- [ ] **Step 5: Rewrite `src/downloader.js`**

Replace the imports and the top of the file:

```js
import { createHash } from 'node:crypto'
import { read as readCallback, write as writeCallback } from 'node:fs'
import { promisify } from 'node:util'

import { returnBigInt } from 'telegram/Helpers.js'

import { PART_SIZE, SLICE_SIZE } from './chunking.js'
import { withRetry } from './retry.js'

const write = promisify(writeCallback)
const read = promisify(readCallback)

// Read back in far bigger bites than the 512KB the network hands us: this loop is pure disk.
const HASH_READ_SIZE = 4 * 1024 * 1024
```

Keep `writeExactly` as it is and add, below it:

```js
async function readExactly(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0

  while (filled < length) {
    const { bytesRead } = await read(fd, buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) {
      throw new Error(`Short read: needed ${length} bytes at offset ${position} but the file ended.`)
    }
    filled += bytesRead
  }

  return buffer
}

// The digest is taken from the assembled range on disk rather than from the buffers as they
// arrive. Once slices land out of order that is the only order left to hash in, and it is
// the better check anyway: a slice written at the wrong offset, two slices overlapping, or
// one silently skipped all show up here. It does not prove the bytes reached the platter —
// this read may well be served from the page cache — it proves the assembly.
async function hashRange(fd, offset, length) {
  const hash = createHash('sha256')

  for (let at = 0; at < length; at += HASH_READ_SIZE) {
    hash.update(await readExactly(fd, Math.min(HASH_READ_SIZE, length - at), offset + at))
  }

  return hash.digest('hex')
}
```

Then replace the whole body of `downloadToFile` after the two existing guards:

```js
export async function downloadToFile(client, message, fd, { offset, onProgress, retryOptions } = {}) {
  const document = message?.media?.document

  if (!document) {
    throw new Error(`Message ${message?.id} has no file attached.`)
  }

  if (!Number.isFinite(offset)) {
    throw new Error(`offset must be a finite number, got: ${offset}`)
  }

  // Telegram's own record of how long the document is. Taking the length from the caller
  // instead would make runRestore's size check compare the manifest against itself.
  const size = returnBigInt(document.size ?? 0).toJSNumber()

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Message ${message?.id} has a document with no usable size.`)
  }

  const sliceCount = Math.ceil(size / SLICE_SIZE)

  // One slice is one short stream. `done` lives outside withRetry, so a retried slice picks
  // up at its own watermark instead of fetching again what it already has.
  //
  // The two offsets are not the same number: `start + done` is a position inside the
  // document, which is where the stream resumes, while `offset + start + done` is a position
  // inside the file being assembled, which is where the bytes land.
  async function downloadSlice(index) {
    const start = index * SLICE_SIZE
    const length = Math.min(SLICE_SIZE, size - start)
    let done = 0

    await withRetry(async () => {
      for await (const buffer of client.iterDownload({
        file: message.media,
        offset: returnBigInt(start + done),
        requestSize: PART_SIZE,
      })) {
        // The stream runs to the end of the document; this slice stops at its own boundary.
        const take = Math.min(buffer.length, length - done)

        await writeExactly(fd, buffer.subarray(0, take), offset + start + done)
        done += take
        onProgress?.(take)

        if (done >= length) break
      }
    }, retryOptions)
  }

  for (let index = 0; index < sliceCount; index += 1) {
    await downloadSlice(index)
  }

  return { sha256: await hashRange(fd, offset, size), size }
}
```

- [ ] **Step 6: Give the one restore test that needs it a document size**

`test/restore.test.js:199-235` streams 900 bytes for a 900-byte document — one slice at offset 0 — so it passes unchanged. Leave it alone.

`test/restore.test.js:396-425` passes a document with no size and would now be refused. Replace its client and call with:

```js
  const client = {
    iterDownload(params) {
      const from = Number(params.offset ?? 0)
      return (async function* () {
        if (!failed) {
          failed = true
          throw new Error('-503: Timeout (caused by upload.GetFile)')
        }
        yield backup.content.subarray(from)
      })()
    },
  }

  const result = await realDownloadChunk(
    client,
    { id: 1, media: { document: { id: 'd', size: backup.content.length } } },
    handle,
    0,
    () => {},
    { baseDelayMs: 0, sleep: async () => {}, onRetry: (err) => attempts.push(err.message) },
  )
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"`
Expected: 0 failures.

- [ ] **Step 8: Commit**

```bash
git add src/chunking.js src/downloader.js test/downloader.test.js test/restore.test.js
git commit -m "refactor: fetch a chunk as 8MB slices, hashed off disk

Each slice is its own short iterDownload stream wrapped in withRetry, resuming at
its own watermark. Still one slice at a time — this changes the shape, not the
speed.

The digest now comes from reading the assembled range back rather than from the
buffers as they arrive, because slices are about to land out of order and that is
the only order left to hash in. It checks the assembly, not the media: the read
may be served from the page cache.

The outer progress-reset loop goes with it. Its comment promised that every byte
gained earned a fresh budget, but withRetry counts attempts internally, so the
budget only ever reset after all five were spent. Per-slice retry makes the
question moot, the way per-part retry already does for upload.

The chunk length now comes from Telegram's own document.size; taking it from the
caller would make runRestore's size check compare the manifest against itself."
```

---

## Task 3: Run the slices through a worker pool

**Files:**
- Modify: `src/downloader.js`, `CLAUDE.md`
- Test: `test/downloader.test.js`

**Interfaces:**
- Consumes: `downloadSlice(index)` and `hashRange` from Task 2.
- Produces: `downloadToFile(client, message, fd, { offset, onProgress, retryOptions, concurrency })`, where `concurrency` defaults to `DEFAULT_CONCURRENCY` (8, already exported from `src/chunking.js`). No CLI flag is added: the spec keeps `restore` knob-free until there is evidence anyone needs one.

- [ ] **Step 1: Write the failing tests**

```js
test('slices are fetched concurrently, not one after another', async () => {
  const content = randomBytes(SLICE_SIZE * 4)
  const { handle } = await tempFd(content.length)
  let inFlight = 0
  let peak = 0

  const client = {
    iterDownload(params) {
      const from = Number(params.offset ?? 0)
      inFlight += 1
      peak = Math.max(peak, inFlight)

      return (async function* () {
        try {
          for (let at = from; at < content.length; at += 512 * 1024) {
            await new Promise((resolve) => setImmediate(resolve))
            yield content.subarray(at, at + 512 * 1024)
          }
        } finally {
          inFlight -= 1
        }
      })()
    },
  }

  await downloadToFile(client, fakeMessage(content.length), handle.fd, { offset: 0, concurrency: 4 })

  await handle.close()
  assert.equal(peak, 4, 'four slices must be in flight at once')
})

test('a chunk of one slice does not start eight workers', async () => {
  const content = randomBytes(1000)
  const { handle } = await tempFd(1000)
  let inFlight = 0
  let peak = 0

  const client = {
    iterDownload(params) {
      const from = Number(params.offset ?? 0)
      inFlight += 1
      peak = Math.max(peak, inFlight)

      return (async function* () {
        try {
          yield content.subarray(from)
        } finally {
          inFlight -= 1
        }
      })()
    },
  }

  await downloadToFile(client, fakeMessage(1000), handle.fd, { offset: 0, concurrency: 8 })

  await handle.close()
  assert.equal(peak, 1)
})

test('one slice failing for good fails the chunk and reports that error', async () => {
  const content = randomBytes(SLICE_SIZE * 3)
  const { handle } = await tempFd(content.length)

  const client = {
    iterDownload(params) {
      const from = Number(params.offset ?? 0)
      return (async function* () {
        if (from >= SLICE_SIZE && from < SLICE_SIZE * 2) throw new Error('slice two is gone')
        for (let at = from; at < content.length; at += 512 * 1024) {
          yield content.subarray(at, at + 512 * 1024)
        }
      })()
    },
  }

  await assert.rejects(
    () => downloadToFile(client, fakeMessage(content.length), handle.fd, {
      offset: 0,
      concurrency: 3,
      retryOptions: { attempts: 2, baseDelayMs: 0, sleep: async () => {} },
    }),
    /slice two is gone/,
  )

  await handle.close()
})

test('a failing slice leaves no unhandled rejection behind', async () => {
  // A worker whose promise rejects while nobody is awaiting it yet becomes an
  // unhandledRejection and buries the real error. uploadRange learned this the hard way.
  const content = randomBytes(SLICE_SIZE * 4)
  const { handle } = await tempFd(content.length)
  const unhandled = []
  const record = (err) => unhandled.push(err)
  process.on('unhandledRejection', record)

  const client = {
    iterDownload(params) {
      const from = Number(params.offset ?? 0)
      return (async function* () {
        if (from > 0) throw new Error('every slice but the first is gone')
        for (let at = from; at < content.length; at += 512 * 1024) {
          yield content.subarray(at, at + 512 * 1024)
        }
      })()
    },
  }

  await assert.rejects(
    () => downloadToFile(client, fakeMessage(content.length), handle.fd, {
      offset: 0,
      concurrency: 4,
      retryOptions: { attempts: 1, baseDelayMs: 0, sleep: async () => {} },
    }),
    /every slice but the first is gone/,
  )

  await new Promise((resolve) => setImmediate(resolve))
  process.off('unhandledRejection', record)

  await handle.close()
  assert.deepEqual(unhandled, [])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/downloader.test.js 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: the first test fails with `peak` of 1 — the loop is still sequential.

- [ ] **Step 3: Implement the pool**

Change the signature and the chunking import:

```js
import { DEFAULT_CONCURRENCY, PART_SIZE, SLICE_SIZE } from './chunking.js'
```

```js
export async function downloadToFile(
  client,
  message,
  fd,
  { offset, onProgress, retryOptions, concurrency = DEFAULT_CONCURRENCY } = {},
) {
```

Replace the sequential `for` loop from Task 2 with:

```js
  let next = 0
  let failed = false
  let failure = null

  const worker = async () => {
    for (;;) {
      // Stop handing out work the moment anything has failed: the chunk is lost either way,
      // and every further request is bandwidth spent on a file about to be thrown away.
      if (failed) return

      const index = next
      next += 1
      if (index >= sliceCount) return

      try {
        await downloadSlice(index)
      } catch (err) {
        // Not `failure ??= err`: a falsy rejection reason would leave `failure` falsy and the
        // throw below would read as success, turning a broken chunk into a silent one. The
        // first error is the one kept — later ones are usually consequences of the shutdown
        // rather than the cause.
        if (!failed) {
          failed = true
          failure = err
        }
        return
      }
    }
  }

  // Every worker absorbs its own error above, so none of these promises rejects and none can
  // become an unhandledRejection that hides the real one. This await is also what guarantees
  // no write is still in flight when the function returns.
  await Promise.all(Array.from({ length: Math.min(concurrency, sliceCount) }, worker))

  if (failed) throw failure

  return { sha256: await hashRange(fd, offset, size), size }
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"`
Expected: 0 failures.

- [ ] **Step 5: Prove the slice offset against GramJS itself, not the fake**

The fake accepts any offset, so this must ask the real thing. Add to `test/downloader.test.js`, and add `import { iterDownload } from 'telegram/client/downloads.js'` at the top:

```js
test('a mid-document slice offset is one GramJS itself accepts', async () => {
  // iterDownload does big-integer arithmetic on `offset` (offset.divide, offset.add), so a
  // plain JS number sails through the fake client and throws against the real one.
  const content = randomBytes(SLICE_SIZE + 1000)
  const { handle } = await tempFd(content.length)
  const client = fakeClient(content, { partSize: 512 * 1024 })

  await downloadToFile(client, fakeMessage(content.length), handle.fd, { offset: 0, concurrency: 1 })
  await handle.close()

  const document = new Api.Document({
    id: bigInt(123),
    accessHash: bigInt(456),
    fileReference: Buffer.alloc(8),
    date: 0,
    mimeType: 'application/octet-stream',
    size: bigInt(content.length),
    dcId: 2,
    attributes: [new Api.DocumentAttributeFilename({ fileName: 'ark.part0001' })],
  })

  const iter = iterDownload(
    { _log: { info() {}, debug() {}, warn() {} } },
    {
      file: new Api.MessageMediaDocument({ document }),
      offset: client.calls[1].offset,
      requestSize: 512 * 1024,
    },
  )

  // A non-zero offset has to route through the iterator that can start mid-document; the
  // direct one only ever begins at zero.
  assert.equal(iter.constructor.name, 'GenericDownloadIter')
})
```

- [ ] **Step 6: Update CLAUDE.md**

Under `## Module boundaries`, after the sentence about `src/uploader.js` and `src/downloader.js` knowing about byte ranges, add:

```markdown
`src/downloader.js` fetches a chunk as 8MB slices through a pool of concurrent
`iterDownload` streams, because one stream is one request at a time and that caps a restore
at round-trip latency — about 3 MB/s — however much bandwidth is going spare. Bytes
therefore land out of order, so the chunk's sha256 is taken by reading the assembled range
back off disk once every slice is in. That check is about assembly, not media: the read may
be served from the page cache.
```

- [ ] **Step 7: Run the whole suite one last time**

Run: `npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"`
Expected: 0 failures.

- [ ] **Step 8: Commit**

```bash
git add src/downloader.js test/downloader.test.js CLAUDE.md
git commit -m "perf: download a chunk through eight concurrent streams

One iterDownload stream issues one GetFile at a time and awaits it, so a restore
was capped by round-trip latency rather than bandwidth: 512KB per request at
~175ms is ~2.9 MB/s whatever the link can carry. Measured on two machines and
two networks, eight concurrent streams reach ~19 MB/s, and the plateau starts
there — 16 is no better, and 24 is no better than 16.

Workers absorb their own errors so no promise rejects unwatched, the first error
is the one reported, and the pool stops handing out slices once anything fails."
```

---

## Verification the test suite cannot do

Every test above talks to a fake client that accepts whatever it is given. Before releasing, and as `CLAUDE.md` requires:

- [x] Restore a real multi-chunk backup larger than 10MB from a real account and compare sha256 against the original in both directions. — 200MB in 2 chunks of 100MB (13 slices each, `InputFileBig`), sha256 recorded before upload, `cmp` byte-identical after restore.
- [x] Restore a backup below the 10MB threshold the same way. — 12MB in 3 chunks of 5MB (`InputFile`, 1 slice each), byte-identical.
- [x] Interrupt the network partway through a restore and confirm it resumes and still verifies, rather than dying or handing over a file that fails its sha256. — 2026-09-06: packets to both DC addresses dropped for 100s, 60s into a 4.3GB restore. All eight in-flight slices announced the stall with their byte watermark, eight of them twice, then resumed and the restore finished with exit 0 and the rename off `.partial` — which only happens after every chunk sha256 and the final length check pass. Uncovered the silent-exit bug fixed by `src/stall.js`.
- [x] Confirm the throughput actually improved — it did, but by half what was predicted: **9.7 MB/s sustained**, ~3.1x the old 3.1 MB/s, putting a 4.3GB restore near 7–8 minutes rather than 4. See the design doc's "What sustained transfer actually measured".
