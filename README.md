# telstore

Split large files into chunks, store them on Telegram, and restore them byte-for-byte.

telstore signs in with your own Telegram account over MTProto, not a bot: the Bot API caps
uploads at 50MB per file, a user account gets 2GB.

Needs Node.js 18+ and an `api_id`/`api_hash` from <https://my.telegram.org> → API
development tools; `login` asks for those, your phone number and the verification code.

## Quick start

```bash
npx telstore login                             # once only
npx telstore config chat @my_backups           # where backups go, from now on
npx telstore data.tar                          # split it and send it there
npx telstore a.tar b.tar c.tar                 # or several: one backup each, one after another
npx telstore list                              # what is already in the destination
npx telstore restore telstore-20260905-7f3a91
```

## Commands

| Command | What it does |
|---|---|
| `telstore login` | Log in to Telegram. Add `--token` to log in with a session token instead. |
| `telstore <file> [file...]` | Split each file and upload it. Prints the `backupId` you restore with. |
| `telstore list` | The backups stored in the destination, newest first. |
| `telstore restore <backup-id>` | Download every chunk and reassemble the file. |
| `telstore delete <backup-id>` | Remove a backup's chunks and manifest from the chat, for good. |
| `telstore status` | Account, destination, and unfinished backups. |
| `telstore config` | Show or change settings. |
| `telstore token` | Print a session token for a machine you do not trust. |
| `telstore logout` | Remove the locally stored session. |

## Settings

`config` writes; flags do not. A flag applies to the run you typed it on and changes nothing
on disk, so `--to @elsewhere` sends one backup elsewhere without moving the destination for
the next one.

```bash
npx telstore config                    # every setting, and whether it is yours or a default
npx telstore config chunkSize 500MB    # change it for good
npx telstore config chunkSize --unset  # back to the default
```

| Setting | Flag | Default | Meaning |
|---|---|---|---|
| `chat` | `--to` | none | `@username`, `-100123…`, or `me` |
| `chunkSize` | `--chunk-size` | `1800MB` | e.g. `1.8GB`, `500MB`. Ceiling 1950MB. |
| `uploadConcurrency` | `--upload-concurrency` | `32` | 512KB parts in parallel while uploading, 1–64 |
| `downloadConcurrency` | `--download-concurrency` | `8` | 8MB slices in parallel while restoring, 1–64 |
| `limit` | `--limit` | `20` | How many backups `list` shows |
| `verbose` | `--verbose` | off | Show the Telegram client's own connection logs |

Three flags have no setting behind them: `--out <path>` names where one restore writes,
`--yes` skips the confirmation `delete` asks, and `--token` takes no value — a token written
on the command line would sit in `ps` and in that machine's shell history, so it is pasted at
a prompt that does not echo.

## What the chat looks like

Every chunk goes up as a document captioned `📦 <backupId> · 3/12`, followed by a manifest
carrying a summary card — file name, size, id, date and the restore command. `list` reads
those cards straight out of the chat, one search and no downloads:

```
Destination  https://web.telegram.org/k/#@my_backups

BACKUP ID                 FILE            SIZE  CHUNKS  CREATED
telstore-20260905-7f3a91  data.tar     21.4 GB      12  2026-09-05
telstore-20260901-9de447  photos.zip  940.3 MB       1  2026-09-01

2 backups. Restore with: npx telstore restore <backup-id>
```

## Several files at once

`telstore a.tar b.tar c.tar` uploads them one after another over a single connection. Each
file becomes its own backup with its own `backupId`, exactly as three separate runs would
have produced. Names that do not exist, and a file named twice, are refused before the first
byte goes out; a file that fails mid-transfer does not stop the ones after it, and the run
ends with a line per file and a non-zero exit code:

```
3 files: 2 uploaded, 1 failed.

  a.tar  telstore-20260905-7f3a91  (12 chunks)
  b.tar  failed: connection dropped mid-transfer
  c.tar  telstore-20260905-9de447  (1 chunk)
```

## Resuming an upload

Progress lives in `~/.telstore/state/` (the 20 most recent), so running the same command
again skips the finished chunks and keeps the same `backupId`. A resumed backup keeps the
chunk size it started with; passing a `--chunk-size` or a destination that differs from its
own makes telstore refuse to run rather than re-cut or redirect it silently.

After a batch, run telstore again with **only the files that are left**: the finished ones
have had their records cleared, so repeating the whole command would upload them a second
time as new backups. `npx telstore status` lists what is unfinished.

**Restore keeps no state** — `Ctrl-C` mid-restore saves nothing, running again starts over.
And `delete` has **no undo**: Telegram is the only copy.

## Running on a machine you do not trust

`login` leaves your session on disk in plain text. When the machine is not yours, print a
**session token** on one that is and log in with that instead:

```bash
npx telstore token          # on your own machine: asks for a passphrase, prints one line
npx telstore login --token  # on the other one: paste the token, then the passphrase
npx telstore logout         # when you are done
```

The token holds your `api_id`, `api_hash`, session and settings, encrypted with the
passphrase (AES-256-GCM, scrypt), as one line of base64url that survives a chat message or a
QR code. `login --token` stores it exactly as it arrived and every command asks for the
passphrase, so the session never exists on that machine in readable form.

There is no expiry and no revocation: to end a session for good, terminate it under Telegram
→ Settings → Devices. An empty passphrase is allowed, and then the token says so on its face
— it starts `tls0.` and `login` stores the session in plain text.

## Limits worth knowing

- **Your data is not encrypted.** Don't upload anything you would mind sitting on someone
  else's infrastructure — the one thing telstore encrypts is a session token, and that
  protects your login rather than your files.
- A chunk cannot exceed 1950MB: Telegram accepts at most 4000 parts of 512KB per file.
- Deleting a chunk message in the Telegram app destroys the backup, and keeping the
  `backupId` is what saves you hunting for its manifest in the chat by hand.

Settings and credentials live in `~/.telstore/config.json`, mode 600 — `apiId`, `apiHash` and
the session at the top level (or a single `sealed` blob after `login --token`), everything
`config` manages under `settings`. Editing it by hand is fine: a value that cannot be used is
named on the next run, with the file and the key.

## License

MIT
