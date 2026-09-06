# Stalls are failures too

- `src/stall.js` gives every network wait 60 seconds of silence before it counts as an
  error. A server that accepts a request and answers nothing leaves `withRetry` no failure
  to see. The timer is deliberately not `unref`'d — it is also what keeps the event loop
  from running dry and exiting without a word.
- Measured per part, never per slice: a link delivering slowly is a link that works, and
  killing it would turn a slow restore into a failed one. One 512KB part slower than 60s
  means under 8KB/s, which could not finish a multi-gigabyte transfer anyway.
- teleproto closes the other half (`connect()` throws once its attempts are spent, and
  `_reconnect()` rejects every pending request), but the deadline stays: the library was
  never the only road to a transfer that stops without failing.
- `src/retry.js` governs upload and download alike: 8 attempts, exponential branch capped at
  30s (past that, doubling buys nothing — the far side has recovered or is not coming back —
  and an uncapped eighth attempt means a two-minute stare at a frozen bar). `FLOOD_WAIT` is
  the one exception to the cap: waited out in full, because guessing short just draws another.
  The backoff totals 91s (1+2+4+8+16+30+30), and with up to a minute of stall deadline on each
  of the eight attempts an outage of roughly nine minutes is survived — announced once a
  minute throughout, so it never reads as a hang — before failing loudly.
- Retries are announced from the third onward: a multi-gigabyte transfer throws off a handful
  of `-503`s that recover on the next try, and one line apiece buries the progress bar. Two
  exceptions are announced immediately — a wait over a minute, and an attempt that itself took
  over a minute to fail, which has already left the bar frozen and reads exactly like the hang
  `src/stall.js` exists to end. `withRetry` passes `onRetry` the attempt's own duration so the
  commands can tell those apart.
