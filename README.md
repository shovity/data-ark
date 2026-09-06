# telstore

Split large files into 1.8GB chunks, store them on Telegram, and restore them intact.

## Quick start

```bash
npx telstore login                        # once only
npx telstore config chat @my_backups      # where backups go, from now on
npx telstore data.tar                     # split it and send it there
npx telstore data.tar --to @somewhere     # somewhere else, this run only
npx telstore config                       # every setting and where its value comes from
npx telstore status                       # account, destination, unfinished backups
npx telstore list                         # what is already stored in the destination
npx telstore restore telstore-20260905-7f3a91
npx telstore delete telstore-20260905-7f3a91   # take it back out of the chat, for good
npx telstore token                        # a session token for a machine you do not trust
```

## What you need

- Node.js 18 or newer.
- An `api_id` and `api_hash` from <https://my.telegram.org> → API development tools. The `login` command asks for both, plus your phone number and the verification code.

telstore signs in with your own Telegram account (MTProto), not a bot. That is a hard requirement: the Bot API caps uploads at 50MB per file, while a user account gets 2GB.

## Settings and flags

There are two ways to say what telstore should do, and they never overlap. **`config` writes;
flags do not.** A flag applies to the run you typed it on and changes nothing on disk, so
`--to @elsewhere` sends one backup elsewhere without moving the destination for the next one.

```bash
npx telstore config                       # everything, and whether it is yours or a default
npx telstore config chat                  # one value, bare, ready to pipe
npx telstore config chunkSize 500MB       # change it for good
npx telstore config chunkSize --unset     # back to the default
```

| Setting | Flag | Default | Meaning |
|---|---|---|---|
| `chat` | `--to` | none | `@username`, `-100123…`, or `me`. A negative channel id works with a space or an `=`, as a flag or as a config value. |
| `chunkSize` | `--chunk-size` | `1800MB` | e.g. `1.8GB`, `500MB`. Hard ceiling 1950MB. An unfinished backup keeps the size it started with. |
| `uploadConcurrency` | `--upload-concurrency` | `32` | 512KB parts sent in parallel while uploading. An integer from 1 to 64. |
| `downloadConcurrency` | `--download-concurrency` | `8` | 8MB slices fetched in parallel while restoring. An integer from 1 to 64. |
| `limit` | `--limit` | `20` | How many backups `list` shows, newest first |
| `verbose` | `--verbose` | off | Show the Telegram client's own connection logs, hidden by default so they do not break up the progress bar |

`--yes` has no setting either — it answers the confirmation `delete` asks before destroying
a backup, and an answer stored in a file would be an answer to a question nobody heard.

`--out <path>` has no setting: it names where one particular restore should write, and
defaults to the basename in the manifest. Relative paths resolve against the current directory.

`config` reads and writes only settings — the `api_id`, `api_hash` and session that `login`
stores in the same file are not reachable from it. A value is checked before it is written,
so `config chunkSize 9GB` is refused there and then rather than at the start of a long upload.

## What the chat looks like

Every chunk goes up as a document captioned `📦 <backupId> · 3/12`, and the manifest that
follows carries a summary card:

```
📄 data.tar
💾 21.4 GB · 12 chunks
🆔 telstore-20260905-7f3a91
📅 2026-09-05 16:40 UTC

↩ npx telstore restore telstore-20260905-7f3a91
#telstore
```

`npx telstore list` reads those cards straight out of the chat — one search, no downloads —
and lays them out as a table:

```
Destination  https://web.telegram.org/k/#@my_backups

BACKUP ID                 FILE            SIZE  CHUNKS  CREATED
telstore-20260905-7f3a91  data.tar     21.4 GB      12  2026-09-05
telstore-20260901-9de447  photos.zip  940.3 MB       1  2026-09-01

2 backups. Restore with: npx telstore restore <backup-id>
```

A backup uploaded before the card existed still gets a row, with dashes where the caption
says nothing — `list` reports what the chat holds and never fills gaps with guesses.

## How it works

Every run mints a `backupId`. The file is read directly by offset — no temporary copies — and uploaded as documents named `<backupId>.partNNNN`. Once every chunk is up, telstore sends a JSON manifest listing the message id and sha256 of each one. Restore needs only the `backupId`: it finds the manifest in the chat, downloads each chunk to its exact position in a `.partial` file, checks every chunk's sha256 and size, and renames it to the real file only after *all* chunks match.

If the connection drops during an **upload**, just run the same command again — progress lives in `~/.telstore/state/` and finished chunks are skipped, keeping the same `backupId`. Two things to know about rerunning:

- Running again against a destination that differs from the one in the unfinished progress makes telstore **refuse to run** rather than silently redirect — one backup cannot be split across two destinations. The error names the chat to pass as `--to` to carry on, or the state file to delete to start a new backup. It reads the same whether the mismatch came from a flag or from your configured `chat`.
- Running again **without** `--chunk-size` resumes at the size the backup started with, whatever your configured `chunkSize` says today. A setting is what to use when nobody asks for anything; it is not somebody asking.
- Running again **with** a `--chunk-size` that differs from that size makes telstore **refuse to run**: the chunks already in the chat were cut that way and cannot be re-cut. Drop the flag to carry on, or delete the state file to start a new backup — which leaves the chunks already sent in the chat with nothing pointing at them.

`Ctrl-C` during an upload names the backup it was working on, so `telstore status` and a later `restore` have something to go on. telstore keeps the **20 most recent** unfinished backups in `~/.telstore/state/`; starting a new one past that drops the oldest record and says which id it dropped. Only the local record goes — the chunks that backup sent stay in the chat, searchable by that id, but it can no longer be resumed.

**Restore keeps no state to resume from.** Pressing `Ctrl-C` mid-restore saves nothing — running again starts over.

## Deleting a backup

```bash
npx telstore delete telstore-20260905-7f3a91
```

It prints what it is about to destroy, asks once, and then removes every chunk message and
the manifest from the chat and drops the local record if there is one. `--yes` skips the
question. **There is no undo** — Telegram is the only copy.

It also works on a backup that never finished: those have chunks in the chat but no manifest,
so `list` cannot see them and only `status` knows they exist. `delete` reads the local record
instead and clears both.

The chunks go first and the manifest goes last, deliberately. The manifest is the only list
of the message ids, so if a delete is interrupted — Ctrl-C, a dropped connection — running
the same command again finds that list still there and finishes the job. Telegram says
nothing about an id that is already gone, so a second run costs nothing. In between the two
runs the backup still shows up in `list`, and a `restore` of it fails loudly rather than
handing over a partial file.

Two things it refuses rather than guesses at: a manifest whose body names a *different*
backup (a file renamed in the chat — its message ids point at somebody else's chunks), and a
manifest or local record giving a message id that is not a whole positive number. Neither
deletes anything at all. A manifest too damaged for `restore` to use *can* still be deleted —
that is usually the one you want gone.

## Running on a machine you do not trust

`login` leaves your Telegram session on the machine you run it on, in plain text. When that
machine is not yours, print a **session token** on one that is and log in with that instead:

```bash
# on the machine you are already logged in on
npx telstore token                        # asks for a passphrase, twice
                                          # prints one line: tls1.…

# on the other machine
npx telstore login --token                # paste the token, then type the passphrase
npx telstore restore telstore-20260905-7f3a91
npx telstore logout                       # when you are done
```

The token holds your `api_id`, `api_hash`, session and settings, encrypted with the
passphrase (AES-256-GCM, key derived with scrypt). It is one line of base64url, so it
survives a chat message, an email or a QR code — and a copy that leaks without the
passphrase is not enough to use your account.

`login --token` stores the token exactly as it arrived, so **the session never exists on that
machine in a form anyone can read**. Every command that talks to Telegram asks for the
passphrase and opens it in memory:

```json
{ "sealed": "tls1.…", "settings": { "chat": "@my_backups" } }
```

`npx telstore status` shows which of the two you are running:

```
Session      /home/you/.telstore/config.json (sealed — opened with a passphrase)
Account      Sho (@shovity)
Destination  https://web.telegram.org/k/#@my_backups
Unfinished   none
```

### What is left behind

- **No readable session.** `logout` removes the sealed blob, and with it the `api_hash`,
  which lives inside it.
- **State files, yes.** An upload writes `~/.telstore/state/<key>.json` so it can be resumed
  after an interruption. It holds the file path, the chunk sizes and the message ids — no
  secret — and losing it would strand chunks in the chat with nothing able to name them.

### Things worth knowing before you use one

- **`--token` takes no value, on purpose.** A token written on the command line would sit in
  `ps` for the whole life of the command and stay in that machine's shell history afterwards.
  It is pasted at a prompt that does not echo it.
- **The passphrase may be left empty**, and then the token says so on its face: it starts
  `tls0.` instead of `tls1.`, `token` warns, and `login` stores the session in plain text
  exactly as an ordinary login would. telstore will not write a file that looks encrypted and
  is not.
- **telstore cannot take a token back.** There is no expiry and no revocation. Like `logout`,
  it says nothing to Telegram — to end the session for good, open Telegram → Settings →
  Devices (Active sessions) and terminate it. Every copy of the token dies with it.
- **A wrong passphrase and a damaged token are the same event** to AES-GCM: one failed
  authentication check. telstore names both possibilities rather than guessing which it was.

## Limits worth knowing

- A chunk cannot exceed 1950MB: Telegram accepts at most 4000 parts of 512KB per file, an arithmetic ceiling of about 1953MB, and telstore stops at 1950MB to leave a safety margin.
- The data is **not** encrypted. Don't upload anything you would mind sitting on someone else's infrastructure. The one thing telstore does encrypt is a session token, and that protects your login rather than your files.
- Deleting a chunk message on Telegram destroys the backup, with no way to recover it. Use `npx telstore delete <backup-id>` when that is what you actually want.
- Keep the `backupId`. Without it you have to hunt for the manifest in the chat by hand.

## Where the config lives

`~/.telstore/config.json` (mode 600) holds `apiId`, `apiHash` and the session at the top level, with everything `config` manages under `settings`:

```json
{
  "apiId": 123456,
  "apiHash": "…",
  "session": "…",
  "settings": { "chat": "@my_backups", "chunkSize": 524288000 }
}
```

A machine logged in with `npx telstore login --token` holds `sealed` instead of those three
fields, and nothing else about the account:

```json
{ "sealed": "tls1.…", "settings": { "chat": "@my_backups" } }
```

A file holding both shapes is refused rather than guessed at — there would be no way to know
which account was meant.

Editing it by hand is fine, and a value that cannot be used is named on the next run — with the file and the key, never with a flag you did not type.

`npx telstore logout` **only deletes the locally stored session** and keeps the rest — the session is still alive on Telegram's side. To revoke access for good, open Telegram → Settings → Devices (Active sessions) and terminate that session.
