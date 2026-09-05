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

## Module boundaries

`src/uploader.js` and `src/downloader.js` know about byte ranges and Telegram's
part APIs; they must not mention CLI flags like `--chunk-size` in their errors.
`src/commands/*.js` own the user-facing narrative. `src/caption.js`,
`src/chunking.js`, `src/manifest.js`, `src/progress.js`, `src/retry.js`,
`src/state.js` and `src/config.js` are pure enough to test without a client.

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
