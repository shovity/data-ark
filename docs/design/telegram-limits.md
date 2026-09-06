# Telegram limits worth remembering

- 512KB parts, at most 4000 per file → a ceiling near 1953MB, so `MAX_CHUNK_SIZE` is 1950MB
  and the default chunk is 1800MB.
- `MAX_CHUNKS` is 10000, counted **before** the plan is built. Every chunk is one message and
  one manifest entry, so a longer plan describes a backup nobody could use — and the only way
  to ask for one is a chunk size picked by mistake, where building it first would mean an
  out-of-memory crash instead of an answer.
- Above 10MB: `SaveBigFilePart` / `InputFileBig`; at or below: `SaveFilePart` / `InputFile`.
  Both branches need real-account coverage.
- `FLOOD_WAIT` is honoured for exactly the seconds the server asks for.
