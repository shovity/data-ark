# Captions

- `src/caption.js` owns what the chat shows. Captions are plain text — no parse mode, so no
  file name is ever escaped. `#telstore` lives on the manifest alone: `list` searches for it,
  and a chunk carrying it would turn one backup into thirteen hits. `--note` rides on the
  manifest for the same reason. `parseNote` folds it onto one line once, so the manifest body
  and the card in the chat can never hold two different notes, and refuses one past
  `MAX_NOTE_LENGTH` rather than cutting it short. The note is the one marker
  `parseManifestCaption` may find missing without calling the card unreadable — every backup
  made before the flag existed has a complete card and no note — and `list` gives it a column
  only when some backup has one, cut to 40 characters there because the whole note is in the
  manifest and on the card for anyone reading it properly.
