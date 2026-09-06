# data-ark

Split large files into 1.8GB chunks, store them on Telegram, and restore them intact.

## Quick start

```bash
npx data-ark login                        # once only
npx data-ark config chat @my_backups      # where backups go, from now on
npx data-ark data.tar                     # split it and send it there
npx data-ark data.tar --to @somewhere     # somewhere else, this run only
npx data-ark config                       # every setting and where its value comes from
npx data-ark status                       # account, destination, unfinished backups
npx data-ark list                         # what is already stored in the destination
npx data-ark restore ark-20260905-7f3a91
```

## What you need

- Node.js 18 or newer.
- An `api_id` and `api_hash` from <https://my.telegram.org> → API development tools. The `login` command asks for both, plus your phone number and the verification code.

data-ark signs in with your own Telegram account (MTProto), not a bot. That is a hard requirement: the Bot API caps uploads at 50MB per file, while a user account gets 2GB.

## Settings and flags

There are two ways to say what data-ark should do, and they never overlap. **`config` writes;
flags do not.** A flag applies to the run you typed it on and changes nothing on disk, so
`--to @elsewhere` sends one backup elsewhere without moving the destination for the next one.

```bash
npx data-ark config                       # everything, and whether it is yours or a default
npx data-ark config chat                  # one value, bare, ready to pipe
npx data-ark config chunkSize 500MB       # change it for good
npx data-ark config chunkSize --unset     # back to the default
```

| Setting | Flag | Default | Meaning |
|---|---|---|---|
| `chat` | `--to` | none | `@username`, `-100123…`, or `me`. A negative channel id works with a space or an `=`, as a flag or as a config value. |
| `chunkSize` | `--chunk-size` | `1800MB` | e.g. `1.8GB`, `500MB`. Hard ceiling 1950MB. An unfinished backup keeps the size it started with. |
| `concurrency` | `--concurrency` | `8` | 512KB parts sent in parallel. An integer from 1 to 64. Upload only — `restore` downloads through its own fixed pool of workers. |
| `limit` | `--limit` | `20` | How many backups `list` shows, newest first |
| `verbose` | `--verbose` | off | Show the Telegram client's own connection logs, hidden by default so they do not break up the progress bar |

`--out <path>` has no setting: it names where one particular restore should write, and
defaults to the basename in the manifest. Relative paths resolve against the current directory.

`config` reads and writes only settings — the `api_id`, `api_hash` and session that `login`
stores in the same file are not reachable from it. A value is checked before it is written,
so `config chunkSize 9GB` is refused there and then rather than at the start of a long upload.

## What the chat looks like

Every chunk goes up as a document captioned `📦 <backupId> · 3/12`, and the manifest that
follows carries a summary card:

```
🗄 data.tar
━━━━━━━━━━━━━━━
💾 21.4 GB · 12 chunks
🆔 ark-20260905-7f3a91
📅 2026-09-05 16:40 UTC

↩ npx data-ark restore ark-20260905-7f3a91
#dataark
```

`npx data-ark list` reads those cards straight out of the chat — one search, no downloads —
and lays them out as a table:

```
Destination  https://web.telegram.org/k/#@my_backups

BACKUP ID            FILE            SIZE  CHUNKS  CREATED
ark-20260905-7f3a91  data.tar     21.4 GB      12  2026-09-05
ark-20260901-9de447  photos.zip  940.3 MB       1  2026-09-01

2 backups. Restore with: npx data-ark restore <backup-id>
```

A backup uploaded before the card existed still gets a row, with dashes where the caption
says nothing — `list` reports what the chat holds and never fills gaps with guesses.

## How it works

Every run mints a `backupId`. The file is read directly by offset — no temporary copies — and uploaded as documents named `<backupId>.partNNNN`. Once every chunk is up, data-ark sends a JSON manifest listing the message id and sha256 of each one. Restore needs only the `backupId`: it finds the manifest in the chat, downloads each chunk to its exact position in a `.partial` file, checks every chunk's sha256 and size, and renames it to the real file only after *all* chunks match.

If the connection drops during an **upload**, just run the same command again — progress lives in `~/.data-ark/state/` and finished chunks are skipped, keeping the same `backupId`. Two things to know about rerunning:

- Running again against a destination that differs from the one in the unfinished progress makes data-ark **refuse to run** rather than silently redirect — one backup cannot be split across two destinations. The error names the chat to pass as `--to` to carry on, or the state file to delete to start a new backup. It reads the same whether the mismatch came from a flag or from your configured `chat`.
- Running again **without** `--chunk-size` resumes at the size the backup started with, whatever your configured `chunkSize` says today. A setting is what to use when nobody asks for anything; it is not somebody asking.
- Running again **with** a `--chunk-size` that differs from that size makes data-ark **refuse to run**: the chunks already in the chat were cut that way and cannot be re-cut. Drop the flag to carry on, or delete the state file to start a new backup — which leaves the chunks already sent in the chat with nothing pointing at them.

`Ctrl-C` during an upload names the backup it was working on, so `data-ark status` and a later `restore` have something to go on. data-ark keeps the **20 most recent** unfinished backups in `~/.data-ark/state/`; starting a new one past that drops the oldest record and says which id it dropped. Only the local record goes — the chunks that backup sent stay in the chat, searchable by that id, but it can no longer be resumed.

**Restore keeps no state to resume from.** Pressing `Ctrl-C` mid-restore saves nothing — running again starts over.

## Limits worth knowing

- A chunk cannot exceed 1950MB: Telegram accepts at most 4000 parts of 512KB per file, an arithmetic ceiling of about 1953MB, and data-ark stops at 1950MB to leave a safety margin.
- The data is **not** encrypted. Don't upload anything you would mind sitting on someone else's infrastructure.
- Deleting a chunk message on Telegram destroys the backup, with no way to recover it.
- Keep the `backupId`. Without it you have to hunt for the manifest in the chat by hand.

## Where the config lives

`~/.data-ark/config.json` (mode 600) holds `apiId`, `apiHash` and the session at the top level, with everything `config` manages under `settings`:

```json
{
  "apiId": 123456,
  "apiHash": "…",
  "session": "…",
  "settings": { "chat": "@my_backups", "chunkSize": 524288000 }
}
```

Editing it by hand is fine, and a value that cannot be used is named on the next run — with the file and the key, never with a flag you did not type.

`npx data-ark logout` **only deletes the locally stored session** and keeps the rest — the session is still alive on Telegram's side. To revoke access for good, open Telegram → Settings → Devices (Active sessions) and terminate that session.
