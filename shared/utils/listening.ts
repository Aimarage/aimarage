export const LISTEN_MODES = ['off', 'suggest', 'auto'] as const
export type ListenMode = typeof LISTEN_MODES[number]

export const DEFAULT_LISTEN_MODE: ListenMode = 'suggest'

export const LISTEN_PREFIX = 'listening:'

export const LISTEN_PLATFORMS = ['bluesky', 'mastodon', 'reddit', 'x', 'threads', 'tiktok', 'youtube'] as const
export type ListenPlatform = typeof LISTEN_PLATFORMS[number]
export const LISTEN_KINDS = ['search', 'mention', 'conversation'] as const
export type ListenKind = typeof LISTEN_KINDS[number]

// Mitreden: Kommentare unter Beiträgen anderer. Bluesky und Mastodon antwortet Aimarage nach der Freigabe selbst,
// X, Threads, TikTok und YouTube postet immer der Mensch ("Kopieren und öffnen").
export const CONVO_PLATFORMS = ['bluesky', 'mastodon', 'x', 'threads', 'tiktok', 'youtube'] as const
export type ConvoPlatform = typeof CONVO_PLATFORMS[number]
export const CONVO_DEFAULT: Record<ConvoPlatform, boolean> = { bluesky: true, mastodon: true, x: true, threads: true, tiktok: true, youtube: true }
export const SELF_REPLY_PLATFORMS: ListenPlatform[] = ['bluesky', 'mastodon']

export interface ListenOrigin {
  platform: ListenPlatform
  kind: ListenKind
  author: string
  root: string
}

export function listenOrigin(o: ListenOrigin): string {
  return `${LISTEN_PREFIX}${[o.platform, o.kind, o.author, o.root].map(x => x.replace(/\|/g, '')).join('|')}`
}

export function parseListenOrigin(origin: string | null | undefined): ListenOrigin | null {
  if (!origin?.startsWith(LISTEN_PREFIX)) return null
  const [platform, kind, author, root] = origin.slice(LISTEN_PREFIX.length).split('|')
  if (!platform || !kind || !(LISTEN_PLATFORMS as readonly string[]).includes(platform) || !(LISTEN_KINDS as readonly string[]).includes(kind)) return null
  return { platform: platform as ListenPlatform, kind: kind as ListenKind, author: author ?? '', root: root ?? '' }
}

export function isListeningTask(t: { origin: string | null }): boolean {
  return !!parseListenOrigin(t.origin)
}

export function repliesItself(t: { origin: string | null }): boolean {
  const o = parseListenOrigin(t.origin)
  return !!o && SELF_REPLY_PLATFORMS.includes(o.platform)
}

export function isConversationTask(t: { origin: string | null }): boolean {
  return parseListenOrigin(t.origin)?.kind === 'conversation'
}

export function convoPlatformsOf(setup: { listening?: { convo?: Partial<Record<ConvoPlatform, boolean>> | null } | null } | null | undefined): Record<ConvoPlatform, boolean> {
  const c = setup?.listening?.convo ?? {}
  return Object.fromEntries(CONVO_PLATFORMS.map(p => [p, typeof c[p] === 'boolean' ? c[p]! : CONVO_DEFAULT[p]])) as Record<ConvoPlatform, boolean>
}

export function listenModeOf(setup: { listening?: { mode?: ListenMode | null } | null } | null | undefined): ListenMode {
  const m = setup?.listening?.mode
  return m && (LISTEN_MODES as readonly string[]).includes(m) ? m : DEFAULT_LISTEN_MODE
}
