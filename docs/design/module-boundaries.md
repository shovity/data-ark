# Module boundaries

- `src/uploader.js` and `src/downloader.js` know byte ranges and Telegram's part APIs; they
  must not mention CLI flags like `--chunk-size` in their errors.
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
