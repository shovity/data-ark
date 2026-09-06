# Terminals

**Terminals too.** `src/prompt.js` first opened a readline per question and passed against a
fake stream; a real pty does not take turns — the first interface keeps the listener, so a
second question reads nothing and reports Ctrl-D. One interface asks every question, with a
curtain in front of its output, and `terminal` follows `stdin.isTTY` (that flag is what stops
the tty driver echoing, leaving the curtain as the only thing between keyboard and screen).
The curtain also draws the mask, because a prompt showing nothing reads as the hang this
project refuses everywhere: the count comes from `rl.line`, the public property — overriding
`_writeToOutput` looks right and is not, since Node's internals have called a symbol-keyed
method since well before 22. One asterisk per character, capped to the question's line with a
trailing `…`; the cap is load-bearing, since the redraw is `\x1b[2K\r` plus the whole line and
a wrapped mask would leave stale asterisks on the rows above.

Verify any prompt change under a real pty, pacing input like a human — lines arriving before
the prompt exists are echoed by the tty and dropped, which looks exactly like a bug and is not:

```bash
( sleep 1.5; echo secret ) | script -qec "node bin/telstore.js token" /dev/null
```

Check asterisks appear as the line is typed, come back when a character is erased, and that
the secret never does.
