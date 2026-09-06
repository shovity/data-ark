import { promises as fs } from 'node:fs'
import path from 'node:path'

// What a command line names and what telstore uploads are not the same list: a folder stands
// for the files inside it, and a pattern for the names that match. Both are resolved here,
// before anything connects, so the run is decided against the disk rather than discovered one
// file at a time.
//
// The shell expands `*` long before node sees it, and that is the expansion telstore prefers —
// this one only runs on a pattern that arrived intact: quoted, or left alone by a shell that
// found nothing to expand it to. Whichever did the work, the rule is the same one glob has
// always had, so a quoted pattern is not a different feature with different results.

// One level, because a folder is a place someone put files, not a tree telstore may walk on
// its own: a recursive sweep of a home directory is thousands of backups nobody asked for.
const HIDDEN = /^\./

function isPattern(text) {
  return /[*?]/.test(text)
}

// `*` and `?` mean what they mean in a shell; everything else is a literal, including the
// regex metacharacters a file name is perfectly allowed to contain.
function patternToRegExp(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/[*?]/g, (char) => (char === '*' ? '[^/]*' : '[^/]'))

  return new RegExp(`^${body}$`)
}

// A directory entry is only a source if it is a file — following symlinks, since a link to a
// file is a perfectly ordinary thing to keep in a folder of backups. Anything that cannot be
// read at all is named rather than dropped.
async function classify(full) {
  try {
    const stat = await fs.stat(full)

    if (stat.isFile()) return { kind: 'file' }
    if (stat.isDirectory()) return { kind: 'skip', reason: 'directory' }

    return { kind: 'skip', reason: 'not a file' }
  } catch (err) {
    return { kind: 'skip', reason: `cannot be read (${err.code ?? err.message})` }
  }
}

async function readEntries(dir) {
  return (await fs.readdir(dir)).sort()
}

async function expandDirectory(dir, skipped) {
  const paths = []
  const folders = []

  for (const name of await readEntries(dir)) {
    if (HIDDEN.test(name)) continue

    const full = path.join(dir, name)
    const { kind, reason } = await classify(full)

    if (kind === 'file') {
      paths.push(full)
      continue
    }

    if (reason === 'directory') folders.push(name)
    skipped.push({ path: full, reason })
  }

  if (paths.length === 0) {
    throw new Error(
      `${dir} has no files to upload — telstore reads one level down and leaves hidden files ` +
        'alone.' +
        (folders.length > 0
          ? ` telstore does not walk into the folders inside it (${folders.join(', ')}) — ` +
            'name one of those instead.'
          : ''),
    )
  }

  return paths
}

async function expandPattern(pattern) {
  const dir = path.dirname(pattern)
  const base = path.basename(pattern)

  if (isPattern(dir)) {
    throw new Error(
      `Wildcards only work in the last part of a path, and ${pattern} has one earlier: ` +
        'telstore does not walk folders looking for matches.',
    )
  }

  let entries

  try {
    entries = await readEntries(dir)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No file matches ${pattern}: ${dir} does not exist.`)
    }
    throw err
  }

  const matches = patternToRegExp(base)
  const paths = []

  for (const name of entries) {
    // A pattern that does not start with a dot does not go looking for hidden files, the same
    // rule every shell uses — otherwise `telstore '*'` in a home directory sends .ssh upwards.
    if (HIDDEN.test(name) && !HIDDEN.test(base)) continue
    if (!matches.test(name)) continue

    const full = path.join(dir, name)
    if ((await classify(full)).kind === 'file') paths.push(full)
  }

  if (paths.length === 0) {
    throw new Error(
      `No file matches ${pattern} in ${dir}. Note that the shell usually expands patterns ` +
        'itself, so a quoted one reaches telstore exactly as typed.',
    )
  }

  return paths
}

/**
 * Turns the positionals of an upload into the list of files it will actually send.
 * Returns `{ paths, skipped }`; a name that is neither a folder nor a pattern is handed on
 * untouched, missing ones included, so "File does not exist" keeps coming from one place.
 */
export async function expandSources(args) {
  const paths = []
  const skipped = []

  for (const arg of args) {
    if (isPattern(arg)) {
      paths.push(...(await expandPattern(arg)))
      continue
    }

    let stat = null

    try {
      stat = await fs.stat(arg)
    } catch {
      paths.push(arg)
      continue
    }

    if (stat.isDirectory()) {
      paths.push(...(await expandDirectory(arg, skipped)))
      continue
    }

    paths.push(arg)
  }

  return { paths, skipped }
}
