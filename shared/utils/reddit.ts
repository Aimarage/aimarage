export const REDDIT_THREAD = 'Reddit-Thread:'
export const REDDIT_NO_ACCESS = 'Reddit-Zugang fehlt:'
export const REDDIT_NONE = 'Reddit ohne Treffer:'
export const REDDIT_SETUP = 'Reddit ist noch nicht eingerichtet.'
export const REDDIT_RETRY = 'Gerade kein passender aktueller Thread'
export const RETRY_DAYS = 3

export type RedditNote =
  | { kind: 'thread', title: string, url: string, excerpt: string, age?: string }
  | { kind: 'access' | 'none', url: string }

export function redditSearchUrl(sub: string | null, query: string): string {
  return sub ? `https://www.reddit.com/r/${sub}/search?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new` : `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&sort=new`
}

export function threadNote(t: { title: string, url: string, excerpt: string, age?: string | null }): string {
  return [`${REDDIT_THREAD} ${t.title}`, t.url, t.age ? `Alter: ${t.age}` : '', t.excerpt].filter(Boolean).join('\n')
}

export function parseRedditNote(text: string): RedditNote | null {
  if (text.startsWith(REDDIT_THREAD)) {
    const [head, url, ...rest] = text.split('\n')
    if (!url?.startsWith('https://')) return null
    const age = rest[0]?.startsWith('Alter: ') ? rest.shift()!.slice(7).trim() : ''
    return { kind: 'thread', title: head!.slice(REDDIT_THREAD.length).trim(), url: url.trim(), excerpt: rest.join(' ').trim(), ...(age ? { age } : {}) }
  }
  for (const [prefix, kind] of [[REDDIT_NO_ACCESS, 'access'], [REDDIT_NONE, 'none']] as const) {
    if (text.startsWith(prefix)) {
      const url = text.slice(prefix.length).trim()
      return url.startsWith('https://') ? { kind, url } : null
    }
  }
  return null
}

export function isRedditNote(text: string): boolean {
  return parseRedditNote(text) !== null
}
