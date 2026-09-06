# Session tokens

- A token arrives through a chat, so `checkTokenBundle` runs on **both** sides — refusing a
  broken bundle on the machine that can fix it rather than the one that cannot.
- `Buffer.from(s, 'base64url')` **silently drops characters outside the alphabet**
  (`'abc!!!def'` → four bytes → `'abcdeQ'`). Re-encoding and comparing is what turns "wrong
  passphrase" into "this was damaged on the way here".
- AES-GCM **cannot tell a wrong key from altered bytes**; both are one failed tag check. The
  message names both, likelier first, and says telstore will not guess.
- scrypt parameters are pinned to the `tls1.` prefix, never carried inside the token: an
  embedded `N` of 2^30 is a denial of service needing no passphrase. `maxmem` is spelled out
  because Node's 32MB default would refuse `N = 2^16` as an error that reads like our bug.
- The passphrase is NFC-normalized on both sides: macOS and Linux spell the same accented
  passphrase with different bytes, and the other spelling is simply a different key.
- An empty passphrase produces `tls0.`, a genuinely different format, and `login` writes the
  ordinary plaintext config. **The config never lies about whether the secret is protected.**
  A config holding both `sealed` and a plain `session` is refused: two sources of truth for
  one account, nothing to say which was meant.
