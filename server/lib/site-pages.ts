import { asc, eq } from 'drizzle-orm'
import { now } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { words } from './documents'
import { getText, parseHtml, robotsAllows, type SitePage } from './site'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

// Projektwissen aus der Website: eigene Seiten (bis Tiefe 2) und direkt verlinkte Inhaltsseiten anderer Websites (z.B. Track-Seiten im Shop).
export const PAGES_MAX_INTERNAL = 30
export const PAGES_MAX_EXTERNAL = 30
export const PAGE_TEXT_MAX = 12_000
export const PAGES_STALE_DAYS = 7
const MAX_DEPTH = 2
const PAGE_EXCERPT = 4000

const SKIP_HOSTS = ['facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com', 'youtu.be', 'linkedin.com', 'spotify.com', 'apple.com', 'deezer.com', 'tidal.com', 'amazon.com', 'amazon.de', 'google.com', 'bsky.app', 'mastodon.social', 'threads.net', 'reddit.com', 'discord.gg', 'discord.com', 't.me', 'whatsapp.com', 'pinterest.com', 'soundcloud.com', 'bandcamp.com', 'distrokid.com', 'patreon.com', 'paypal.com', 'github.com', 'wikipedia.org']
const SKIP_PATH = /\/(login|signin|sign-in|register|account|cart|checkout|warenkorb|kasse|privacy|datenschutz|imprint|impressum|tos|terms|agb|legal|cookies?|feed|rss|wp-admin|wp-login|tag|tags|author|search|suche)(\/|$)/i

export type StoredPage = typeof schema.projectPages.$inferSelect
export type CrawledPage = Pick<SitePage, 'url' | 'title' | 'description' | 'text'> & { image: string | null, linkedFrom: string | null }
export type PageLike = Pick<StoredPage, 'url' | 'title' | 'description' | 'text' | 'image' | 'linkedFrom'>

export function pageKey(raw: string): string {
  const u = new URL(raw)
  u.hash = ''
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^(ref|fbclid|gclid)$/i.test(k)) u.searchParams.delete(k)
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '')
  return u.href
}

export function contentLink(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (!/^https?:$/.test(u.protocol) || u.pathname.length <= 1) return false
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    if (SKIP_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) return false
    return !SKIP_PATH.test(u.pathname)
  }
  catch {
    return false
  }
}

export async function crawlSite(url: string, opts: { fetchImpl?: FetchLike, maxInternal?: number, maxExternal?: number, timeoutMs?: number, delayMs?: number } = {}): Promise<{ pages: CrawledPage[], error: string | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 8000
  const delayMs = opts.delayMs ?? 250
  let start: URL
  try {
    start = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
  }
  catch {
    return { pages: [], error: 'Ungültige Adresse' }
  }
  const robots = new Map<string, string>()
  const allowed = async (u: URL) => {
    if (!robots.has(u.origin)) {
      let txt = ''
      try {
        const r = await getText(`${u.origin}/robots.txt`, fetchImpl, 4000)
        if (r.status === 200 && !/html/i.test(r.type)) txt = r.text
      }
      catch {}
      robots.set(u.origin, txt)
    }
    return robotsAllows(robots.get(u.origin)!, u.pathname)
  }
  const pause = () => (delayMs ? new Promise(r => setTimeout(r, delayMs)) : Promise.resolve())
  const read = async (link: string) => {
    const r = await getText(link, fetchImpl, timeoutMs)
    if (r.status >= 400 || !/html/i.test(r.type || 'text/html')) return null
    return parseHtml(r.text, r.url, { maxText: PAGE_TEXT_MAX, main: true })
  }
  const pages: CrawledPage[] = []
  const seen = new Set<string>([pageKey(start.href)])
  const queue: { url: string, depth: number, from: string | null }[] = [{ url: start.href, depth: 0, from: null }]
  const external = new Map<string, string>()
  let error: string | null = null
  let internal = 0
  while (queue.length && internal < (opts.maxInternal ?? PAGES_MAX_INTERNAL)) {
    const next = queue.shift()!
    try {
      if (!(await allowed(new URL(next.url)))) {
        if (!next.from) return { pages, error: 'robots.txt erlaubt den Abruf nicht' }
        continue
      }
      if (internal) await pause()
      const p = await read(next.url)
      if (!p) {
        if (!next.from) return { pages, error: 'Startseite nicht lesbar' }
        continue
      }
      internal++
      pages.push({ url: pageKey(p.url), title: p.title, description: p.description, text: p.text, image: p.image ?? null, linkedFrom: next.from })
      if (next.depth < MAX_DEPTH) {
        for (const l of p.links) {
          const k = pageKey(l)
          if (seen.has(k) || SKIP_PATH.test(new URL(k).pathname)) continue
          seen.add(k)
          queue.push({ url: k, depth: next.depth + 1, from: pageKey(p.url) })
        }
      }
      for (const l of p.external) {
        const k = pageKey(l)
        if (!seen.has(k) && contentLink(k)) {
          seen.add(k)
          external.set(k, pageKey(p.url))
        }
      }
    }
    catch (err) {
      if (!next.from) return { pages, error: (err as Error).name === 'AbortError' ? 'Zeitüberschreitung' : (err as Error).message.slice(0, 200) }
    }
  }
  let ext = 0
  for (const [link, from] of external) {
    if (ext >= (opts.maxExternal ?? PAGES_MAX_EXTERNAL)) break
    try {
      if (!(await allowed(new URL(link)))) continue
      await pause()
      const p = await read(link)
      if (!p) continue
      ext++
      pages.push({ url: link, title: p.title, description: p.description, text: p.text, image: p.image ?? null, linkedFrom: from })
    }
    catch (err) {
      error = `${link}: ${(err as Error).message.slice(0, 120)}`
    }
  }
  return { pages, error }
}

export async function savePages(db: Db, projectId: string, pages: CrawledPage[]): Promise<number> {
  if (!pages.length) return 0
  const at = now()
  const unique = [...new Map(pages.map(p => [p.url, p])).values()]
  await db.transaction(async (tx) => {
    await tx.delete(schema.projectPages).where(eq(schema.projectPages.projectId, projectId))
    await tx.insert(schema.projectPages).values(unique.map(p => ({ projectId, url: p.url, title: p.title, description: p.description, text: p.text, image: p.image, linkedFrom: p.linkedFrom, fetchedAt: at })))
  })
  return unique.length
}

export async function projectPages(db: DbOrTx, projectId: string): Promise<StoredPage[]> {
  return db.select().from(schema.projectPages).where(eq(schema.projectPages.projectId, projectId)).orderBy(asc(schema.projectPages.fetchedAt), asc(schema.projectPages.id))
}

export function pagesStale(pages: Pick<StoredPage, 'fetchedAt'>[], at = now()): boolean {
  if (!pages.length) return true
  const newest = Math.max(...pages.map(p => p.fetchedAt.getTime()))
  return at.getTime() - newest > PAGES_STALE_DAYS * 86_400_000
}

export async function readProjectSite(db: Db, project: { id: string, url: string | null }, opts: { fetchImpl?: FetchLike, delayMs?: number } = {}): Promise<{ pages: number, external: number, error: string | null }> {
  if (!project.url?.trim()) return { pages: 0, external: 0, error: 'Keine Website' }
  const r = await crawlSite(project.url, opts)
  const n = await savePages(db, project.id, r.pages)
  const host = new URL(r.pages[0]?.url ?? 'https://x.invalid').host
  return { pages: n, external: r.pages.filter(p => new URL(p.url).host !== host).length, error: r.error }
}

function headWords(p: PageLike): Set<string> {
  let path = ''
  try {
    path = decodeURIComponent(new URL(p.url).pathname).replace(/[-_/.]+/g, ' ')
  }
  catch {}
  return words(`${p.title ?? ''} ${path}`)
}

export function pageScore(p: PageLike, q: Set<string>, weight: (w: string) => number = () => 1): number {
  const head = headWords(p)
  const body = words(`${p.description ?? ''} ${p.text}`)
  let s = 0
  for (const x of q) s += (head.has(x) ? 3 : body.has(x) ? 1 : 0) * weight(x)
  return s
}

// Seiten zur Aufgabe: Treffer in Titel und Pfad zählen mehr als im Text, seltene Wörter mehr als solche, die auf fast jeder Seite stehen;
// Seiten, die von einer Seite mit Treffer in Titel oder Pfad verlinkt sind (z.B. Track-Seiten unter der Albumseite), zählen diesen Treffer mit; die Startseite verleiht keinen Bonus.
export function relevantPages<T extends PageLike>(pages: T[], query: string, budget: number, opts: { pick?: string[], perPage?: number } = {}): { page: T, text: string }[] {
  const q = words(query)
  if ((!q.size && !opts.pick?.length) || budget <= 0) return []
  const pick = new Set((opts.pick ?? []).map(u => {
    try {
      return pageKey(u)
    }
    catch {
      return u
    }
  }))
  const sets = pages.map(p => new Set([...headWords(p), ...words(`${p.description ?? ''} ${p.text}`)]))
  const df = new Map([...q].map(x => [x, sets.filter(w => w.has(x)).length]))
  const weight = (x: string) => (df.get(x) ? 1 + Math.log2(pages.length / df.get(x)!) : 0)
  const base = new Map(pages.map(p => [p.url, pageScore(p, q, weight)]))
  const head = new Map(pages.map((p) => {
    const h = headWords(p)
    return [p.url, [...q].reduce((n, x) => n + (h.has(x) ? 3 * weight(x) : 0), 0)]
  }))
  const scored = pages.map((p, i) => {
    const s = (base.get(p.url) ?? 0) + (p.linkedFrom && new URL(p.linkedFrom).pathname !== '/' ? head.get(p.linkedFrom) ?? 0 : 0) + (pick.has(p.url) ? 100 : 0)
    return { p, s, i }
  }).filter(x => x.s >= 2 || pick.has(x.p.url))
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  const out: { page: T, text: string }[] = []
  let used = 0
  for (const x of scored) {
    const text = x.p.text.slice(0, opts.perPage ?? PAGE_EXCERPT)
    if (!text.trim() || used + text.length > budget) continue
    out.push({ page: x.p, text })
    used += text.length
  }
  return out
}

export function pagesDigest(sel: { page: PageLike, text: string }[]): string[] {
  return sel.map(({ page, text }) => `Seite ${page.url}${page.title ? ` (${page.title})` : ''}${page.image ? `, Bild: ${page.image}` : ''}:\n${text}`)
}

export function pagesIndex(pages: PageLike[], max = 80): string {
  return pages.slice(0, max).map(p => `- ${p.url}${p.title ? ` | ${p.title}` : ''}${p.description ? ` | ${p.description.slice(0, 120)}` : ''}`).join('\n')
}
