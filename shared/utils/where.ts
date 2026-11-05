import { isCommunitySweep } from './community-sweep'
import { needsThread, platformOf, taskType } from './drafting'
import { isHttpUrl } from './url'
import { onSite, siteLinks } from './utm'

export type WhereKind = 'social' | 'community' | 'directory' | 'mail' | 'blog' | 'external' | 'none'

export interface TaskWhere {
  kind: WhereKind
  mark: string | null
  place: string | null
  url: string | null
  by: 'agent' | 'human'
  missing: boolean
  setup?: 'reddit'
  // Neuer Beitrag (keine Antwort): Ziel ist das Subreddit, url der Link zum Einreichen.
  newPost?: boolean
}

export interface WhereTask {
  title: string
  category: string
  channel?: string | null
  targetUrl?: string | null
  draftKind?: string | null
  origin?: string | null
  agentStep?: string | null
  humanStep?: string | null
  description?: string | null
}

export interface WhereContext {
  blog?: string | null
  // Projekt-Website, für Kanäle wie "tonebase.de/blog" mit falscher Endung.
  site?: string | null
  channelName?: string | null
  places?: string[]
  recipient?: string | null
  accounts?: string[]
  autoPost?: boolean
  autoMail?: boolean
  autoBlog?: boolean
  reddit?: boolean
  reply?: { platform: string, connected: boolean } | null
}

const OWN_BLOG = /^(eigene[rsn]?\s+)?(seo\s*(&|und|\/)\s*)?(blog|ratgeber|website|webseite|seite|homepage|blog[- ]?(bereich|seite)|ratgeber[- ]?(bereich|seite)|blog (und|\/|&) ratgeber|blog\/ratgeber)(\s*\(.*\))?$/i

export function isOwnBlog(place: string | null | undefined): boolean {
  return !!place && OWN_BLOG.test(place.trim())
}

function brandOf(s: string | null | undefined): string | null {
  const host = s?.trim().replace(/^https?:\/\//i, '').split(/[/?#\s]/)[0]?.toLowerCase().replace(/^www\./, '')
  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null
  const labels = host.split('.')
  return labels[labels.length - 2] ?? null
}

// Kanal wie "tonebase.de/blog", der eigene Blog liegt aber auf tonebase.com: gleicher Name, andere Endung zählt als eigener Blog.
export function isOwnSite(channel: string | null | undefined, blog: string | null | undefined): boolean {
  const a = brandOf(channel)
  return !!a && a === brandOf(blog)
}

export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
}

function subreddit(...texts: (string | null | undefined)[]): string | null {
  for (const s of texts) {
    const m = s ? /(?:^|[\s/(])r\/([A-Za-z0-9_]{2,30})/.exec(s) : null
    if (m) return `r/${m[1]}`
  }
  return null
}

export function contentTarget(blog: string | null | undefined, places: string[]): { place: string, url: string | null, external: boolean } | null {
  if (blog && isHttpUrl(blog)) return { place: bareUrl(blog), url: blog, external: false }
  const url = places.find(isHttpUrl)
  if (url) return { place: bareUrl(url), url, external: false }
  const ext = places.find(p => !isOwnBlog(p))
  return ext ? { place: ext, url: null, external: true } : null
}

export function needsBlog(category: string, places: string[], blog: string | null | undefined): boolean {
  return category === 'content' && !contentTarget(blog, places)
}

// Neuer Reddit-Beitrag statt Antwort auf einen Thread.
export function redditNewPost(t: Pick<WhereTask, 'title' | 'category' | 'channel' | 'draftKind' | 'description'>): boolean {
  return taskType({ title: t.title, category: t.category, channel: t.channel, draftKind: t.draftKind, description: t.description }) === 'post'
}

export function submitUrl(sub: string): string {
  return `https://www.reddit.com/${sub}/submit`
}

export function taskWhere(t: WhereTask, ctx: WhereContext = {}): TaskWhere {
  const human = (kind: WhereKind, mark: string | null, place: string | null, url: string | null = null, missing = false): TaskWhere => ({ kind, mark, place, url, by: 'human', missing })
  const channel = t.channel?.trim() || null
  const url = isHttpUrl(t.targetUrl) ? t.targetUrl!.trim() : null
  const places = ctx.places ?? []
  if (t.draftKind === 'mail') return { kind: 'mail', mark: 'mail', place: ctx.recipient?.trim() || null, url: null, by: ctx.autoMail ? 'agent' : 'human', missing: false }
  const p = platformOf({ title: t.title, category: t.category, channel, targetUrl: t.targetUrl })
  if (isCommunitySweep(t)) return { kind: 'community', mark: p === 'reddit' ? 'reddit' : 'forum', place: null, url: null, by: 'agent', missing: false, ...(ctx.reddit === false ? { setup: 'reddit' as const } : {}) }
  if (ctx.reply) return { kind: 'social', mark: ctx.reply.platform, place: null, url, by: ctx.reply.connected ? 'agent' : 'human', missing: !ctx.reply.connected }
  if (p === 'reddit') {
    const sub = subreddit(channel, t.targetUrl, t.title) ?? subreddit(...places) ?? subreddit(t.description)
    if (redditNewPost(t)) return { ...human('community', 'reddit', sub, sub ? submitUrl(sub) : null, !sub), newPost: true }
    const w = human('community', 'reddit', sub, url, !sub)
    return ctx.reddit === false && !url && needsThread(t) ? { ...w, setup: 'reddit' } : w
  }
  if (p && p !== 'forum') return { kind: 'social', mark: p, place: null, url, by: ctx.autoPost ? 'agent' : 'human', missing: !!ctx.accounts && !ctx.accounts.includes(p) }
  if (t.category === 'social') return { kind: 'social', mark: null, place: null, url, by: ctx.autoPost ? 'agent' : 'human', missing: !!ctx.accounts && !ctx.accounts.length }
  const generic = !channel || (!!ctx.channelName && channel.toLowerCase() === ctx.channelName.trim().toLowerCase())
  if (t.category === 'community' || p === 'forum') {
    const place = url ? bareUrl(url) : !generic ? channel : places[0] ?? null
    return human('community', subreddit(place) ? 'reddit' : 'forum', place, url, !place)
  }
  if (t.category === 'verzeichnis') {
    const place = url ? bareUrl(url) : !generic ? channel : null
    return human('directory', 'directory', place, url, !place)
  }
  if (t.category === 'content' || t.draftKind === 'article') {
    const ownSite = !!channel && !generic && (isOwnSite(channel, ctx.blog) || isOwnSite(channel, ctx.site))
    if (channel && !generic && !isOwnBlog(channel) && !ownSite) return human('external', 'external', channel, url)
    const target = contentTarget(ctx.blog ?? (ownSite && ctx.site ? `${ctx.site.replace(/\/$/, '')}/blog` : null), generic ? places : places.filter(isHttpUrl))
    if (!target) return human('blog', 'blog', null, null, true)
    const w = human(target.external ? 'external' : 'blog', target.external ? 'external' : 'blog', target.place, target.url)
    return !target.external && ctx.autoBlog ? { ...w, by: 'agent' } : w
  }
  if (channel && !generic) return human('external', 'external', url ? bareUrl(url) : channel, url)
  return human('none', null, null)
}

export function hasUtm(url: string): boolean {
  try {
    return [...new URL(url).searchParams.keys()].some(k => k.startsWith('utm_'))
  }
  catch {
    return false
  }
}

export function hostPath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`
  }
  catch {
    return bareUrl(url)
  }
}

const REDDIT_THREAD = /^https?:\/\/([a-z0-9-]+\.)?reddit\.com\/r\/[^/]+\/comments\//i

export function postTarget(urls: (string | null | undefined)[], w: Pick<TaskWhere, 'mark' | 'place' | 'newPost'>, opts: { community?: boolean, siteHosts?: string[] } = {}): string | null {
  const ok = urls.filter((u): u is string => isHttpUrl(u)).map(u => u.trim())
    .filter(u => !hasUtm(u) && !(opts.community && opts.siteHosts?.length && onSite(u, opts.siteHosts)))
  if (w.mark === 'reddit' && w.newPost) return w.place && /^r\/[A-Za-z0-9_]{2,30}$/.test(w.place) ? submitUrl(w.place) : null
  if (w.mark === 'reddit') {
    const thread = ok.find(u => REDDIT_THREAD.test(u))
    if (thread) return thread
    const sub = w.place ? /^r\/([A-Za-z0-9_]{2,30})$/.exec(w.place)?.[1] : null
    if (sub) return `https://www.reddit.com/r/${sub}/submit`
    return ok.find(u => !/reddit\.com\/search/i.test(u)) ?? null
  }
  return ok[0] ?? null
}

export function postLink(texts: (string | null | undefined)[], siteHosts: string[], utmUrl: string | null, community: boolean): { url: string, inText: boolean } | null {
  const inText = siteLinks(texts.filter(Boolean).join('\n'), siteHosts)[0]
  if (inText) return { url: inText, inText: true }
  return utmUrl && !community ? { url: utmUrl, inText: false } : null
}
