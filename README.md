# data-ark

Split large files into 1.8GB chunks, store them on Telegram, and restore them intact.

## Quick start

```bash
npx data-ark login                        # once only
npx data-ark data.tar --to @my_backups    # the destination is remembered
npx data-ark --to @my_backups             # only change the destination, upload nothing
npx data-ark status                       # account, destination, unfinished backups
npx data-ark list                         # what is already stored in the destination
npx data-ark data.tar                     # from the second run on
npx data-ark restore ark-20260905-7f3a91
```

## What you need

- Node.js 18 or newer.
- An `api_id` and `api_hash` from <https://my.telegram.org> → API development tools. The `login` command asks for both, plus your phone number and the verification code.

data-ark signs in with your own Telegram account (MTProto), not a bot. That is a hard requirement: the Bot API caps uploads at 50MB per file, while a user account gets 2GB.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--to <chat>` | the remembered destination | `@username`, `-100123…`, or `me`. `upload` and `status` remember it; `list` and `restore` only look there. A negative channel id works either way: `--to -100123…` or `--to=-100123…` |
| `--chunk-size <n>` | `1800MB` | e.g. `1.8GB`, `500MB`. Hard ceiling 1950MB. |
| `--concurrency <n>` | `8` | 512KB parts sent in parallel. An integer from 1 to 64. |
| `--out <path>` | the basename from the manifest | Where to write the restored file; relative paths resolve against the current directory |
| `--limit <n>` | `20` | How many backups `list` shows, newest first |
| `--verbose` | off | Show the Telegram client's own connection logs, hidden by default so they do not break up the progress bar |

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
`--to` here only chooses which chat to look at; it does not move the destination the way
`status --to` does.

## How it works

Every run mints a `backupId`. The file is read directly by offset — no temporary copies — and uploaded as documents named `<backupId>.partNNNN`. Once every chunk is up, data-ark sends a JSON manifest listing the message id and sha256 of each one. Restore needs only the `backupId`: it finds the manifest in the chat, downloads each chunk to its exact position in a `.partial` file, checks every chunk's sha256 and size, and renames it to the real file only after *all* chunks match.

If the connection drops during an **upload**, just run the same command again — progress lives in `~/.data-ark/state/` and finished chunks are skipped, keeping the same `backupId`. Two things to know about rerunning:

- Running again with a `--to` that differs from the destination stored in the unfinished progress makes data-ark **refuse to run** rather than silently redirect — one backup cannot be split across two destinations. The error points the way out: drop `--to` to keep sending to the original destination, or delete the state file to start a new backup.
- Running again with a different `--chunk-size` is treated as an entirely new backup (new backup id), not a resume.

**Restore keeps no state to resume from.** Pressing `Ctrl-C` mid-restore saves nothing — running again starts over.

## Limits worth knowing

- A chunk cannot exceed 1950MB: Telegram accepts at most 4000 parts of 512KB per file, an arithmetic ceiling of about 1953MB, and data-ark stops at 1950MB to leave a safety margin.
- The data is **not** encrypted. Don't upload anything you would mind sitting on someone else's infrastructure.
- Deleting a chunk message on Telegram destroys the backup, with no way to recover it.
- Keep the `backupId`. Without it you have to hunt for the manifest in the chat by hand.

## Where the config lives

`~/.data-ark/config.json` (mode 600) holds `apiId`, `apiHash`, the session and the default destination. `npx data-ark logout` **only deletes the locally stored session** and keeps the rest — the session is still alive on Telegram's side. To revoke access for good, open Telegram → Settings → Devices (Active sessions) and terminate that session.
