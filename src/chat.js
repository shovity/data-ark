// How telark talks about a destination. None of this touches Telegram — it is string
// handling around a target the user typed — so it lives apart from the client that does.

export function normalizeChatTarget(input) {
  const text = String(input).trim()

  if (text === '') {
    throw new Error('Destination must not be empty.')
  }

  if (/^-?\d+$/.test(text)) {
    return Number(text)
  }

  return text
}

// Telegram's web client addresses a chat by putting the raw target in the fragment, which
// covers both a negative channel id and an @username. Saved Messages is the exception: it
// is reached by the account's own id, which telark does not know, so it gets no link
// rather than a guessed one that lands somewhere else.
export function chatUrl(chat) {
  const text = String(chat)

  if (text === 'me') return null

  return `https://web.telegram.org/k/#${text}`
}

// How a destination is spoken about. "me" is a target, not a name someone would recognise
// in a sentence, so every command that mentions a chat in prose goes through here.
export function chatName(chat) {
  return String(chat) === 'me' ? 'Saved Messages' : String(chat)
}

// A destination is worth more as something clickable than as a raw id, but Saved Messages
// has no link to give, so it is named instead of being dressed up as one.
export function describeChat(chat) {
  const url = chatUrl(chat)

  return url ?? `${chat} (${chatName(chat)})`
}
