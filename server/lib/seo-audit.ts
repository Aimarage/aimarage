import { and, eq, gte, inArray, like, or } from 'drizzle-orm'
import { z } from 'zod'
import { addDays } from '../../shared/utils/dates'
import { CATEGORY_CODES, OPEN_STATUSES } from '../../shared/utils/domain'
import { now, today } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { chatJson, llmStatus, type ChatResult, type LlmConfig } from './llm'
import { searchRange, searchSummary } from './search-console'
import { assertPublicHost, parseHtml, safeFetch, robotsAllows, SITE_UA } from './site'
import { projectOwner } from './strategy'
import { createTask, nextTaskCode, ORDER_MAX, websiteOrder } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const SEO_MAX_PAGES = 30
const MAX_LINK_CHECKS = 40
const MAX_BYTES = 2_000_000
export const TITLE_MAX = 60
export const DESC_MAX = 160
export const THIN_WORDS = 250
const SLOW_MS = 2000
const HEAVY_BYTES = 400_000

export const SEO_CODES = ['http_error', 'noindex', 'title_missing', 'pagespeed', 'h1_missing', 'title_long', 'title_duplicate', 'desc_missing', 'hreflang_missing', 'slow', 'desc_long', 'h1_multiple', 'img_alt', 'canonical_missing', 'canonical_other', 'thin', 'heavy'] as const
export type SeoCode = typeof SEO_CODES[number]

export interface SeoIssue {
  code: SeoCode
  severity: 1 | 2 | 3
  url: string
  label: string
  params: Record<string, string | number>
}

export interface SeoPage {
  url: string
  status: number
  ms: number
  bytes: number
  title: string | null
  description: string | null
  h1: string | null
  h1Count: number
  imgNoAlt: number
  words: number
  canonical: string | null
  noindex: boolean
  hreflang: number
  lang: string | null
  excerpt: string
}

export interface SeoAuditResult {
  url: string
  checkedAt: string
  pages: SeoPage[]
  issues: SeoIssue[]
  linksChecked: number
  pagespeed: { score: number, lcp: string | null } | null
  error: string | null
}

export interface Fetched {
  status: number
  url: string
  type: string
  html: string
  ms: number
  bytes: number
  robotsHeader: string
  lastModified: string | null
}

export async function fetchTimed(url: string, f: FetchLike, method: 'GET' | 'HEAD' = 'GET', timeoutMs = 10_000): Promise<Fetched> {
  const start = Date.now()
  const res = await safeFetch(url, { method, signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': SITE_UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } }, f)
  const type = res.headers.get('content-type') ?? ''
  let html = ''
  let bytes = 0
  if (method === 'GET' && res.body) {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes <= MAX_BYTES) html += dec.decode(value, { stream: true })
      else {
        await reader.cancel().catch(() => {})
        break
      }
    }
  }
  return { status: res.status, url: res.url || url, type, html, ms: Date.now() - start, bytes, robotsHeader: res.headers.get('x-robots-tag') ?? '', lastModified: res.headers.get('last-modified') }
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

function tags(html: string, name: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(m => attrs(m[0]))
}

function decode(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
}

function textOf(s: string): string {
  return decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function analyzePage(html: string, url: string, meta: { status: number, ms: number, bytes: number, robotsHeader?: string }): SeoPage & { links: string[] } {
  const parsed = parseHtml(html, url)
  const head = html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
  const body = head.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  const metas = tags(head, 'meta')
  const links = tags(head, 'link')
  const description = metas.find(m => m.name?.toLowerCase() === 'description')?.content
  const robots = metas.filter(m => /^(robots|googlebot)$/i.test(m.name ?? '')).map(m => m.content ?? '').join(',')
  const h1s = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => textOf(m[1]!))
  const imgs = tags(body, 'img')
  const bodyText = textOf((/<body\b[\s\S]*$/i.exec(body)?.[0] ?? body).replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, ' '))
  const words = bodyText.split(' ').filter(w => /\p{L}{2,}/u.test(w)).length
  const canonical = links.find(l => /(^|\s)canonical(\s|$)/i.test(l.rel ?? ''))?.href
  let canon: string | null = null
  try {
    canon = canonical ? new URL(decode(canonical), url).href : null
  }
  catch {}
  return {
    url,
    status: meta.status,
    ms: meta.ms,
    bytes: meta.bytes,
    title: parsed.title,
    description: description !== undefined ? decode(description).trim() : null,
    h1: h1s[0] ?? null,
    h1Count: h1s.length,
    imgNoAlt: imgs.filter(i => !('alt' in i)).length,
    words,
    canonical: canon,
    noindex: /noindex/i.test(robots) || /noindex/i.test(meta.robotsHeader ?? ''),
    hreflang: links.filter(l => /alternate/i.test(l.rel ?? '') && l.hreflang).length,
    lang: attrs(/<html\b[^>]*>/i.exec(html)?.[0] ?? '').lang ?? null,
    excerpt: bodyText.slice(0, 600),
    links: parsed.links,
  }
}

export function keyOf(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || ''}${u.search}`
  }
  catch {
    return url
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}` || '/'
  }
  catch {
    return url
  }
}

async function readSitemap(origin: string, robots: string, f: FetchLike): Promise<{ urls: string[], alternates: Set<string> }> {
  const listed = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]!)
  const queue = listed.length ? listed.slice(0, 3) : [`${origin}/sitemap.xml`]
  const urls: string[] = []
  const alternates = new Set<string>()
  let fetched = 0
  while (queue.length && fetched < 5) {
    const sm = queue.shift()!
    fetched++
    try {
      if (new URL(sm).origin !== origin) continue
      const r = await fetchTimed(sm, f, 'GET', 8000)
      if (r.status !== 200) continue
      for (const block of r.html.matchAll(/<(url|sitemap)>([\s\S]*?)<\/\1>/gi)) {
        const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(block[2]!)?.[1]
        if (!loc) continue
        const u = decode(loc)
        if (block[1]!.toLowerCase() === 'sitemap') queue.push(u)
        else if (u.startsWith(origin)) {
          urls.push(u)
          if (/hreflang=/i.test(block[2]!)) alternates.add(keyOf(u))
        }
      }
    }
    catch {}
  }
  return { urls, alternates }
}

function issue(code: SeoCode, severity: 1 | 2 | 3, url: string, params: Record<string, string | number> = {}): SeoIssue {
  return { code, severity, url, label: issueLabel(code, params), params }
}

export function issueLabel(code: SeoCode, p: Record<string, string | number>): string {
  switch (code) {
    case 'http_error': return `Link führt ins Leere (Fehler ${p.status})${p.from ? `, verlinkt auf ${p.from}` : ''}`
    case 'noindex': return 'Für Google gesperrt (noindex)'
    case 'title_missing': return 'Seitentitel fehlt'
    case 'title_long': return `Seitentitel zu lang (${p.len} Zeichen, gut sind bis ${TITLE_MAX})`
    case 'title_duplicate': return `Gleicher Seitentitel wie ${p.other}`
    case 'desc_missing': return 'Meta-Beschreibung fehlt (Text unter dem Link in Google)'
    case 'desc_long': return `Meta-Beschreibung zu lang (${p.len} Zeichen, gut sind bis ${DESC_MAX})`
    case 'h1_missing': return 'Hauptüberschrift (H1) fehlt'
    case 'h1_multiple': return `${p.n} Hauptüberschriften (H1), besser genau eine`
    case 'img_alt': return `${p.n} Bilder ohne Bildbeschreibung (alt)`
    case 'thin': return `Wenig Text (${p.words} Wörter)`
    case 'canonical_missing': return 'Kein Canonical-Link'
    case 'canonical_other': return `Canonical zeigt auf eine andere Seite (${p.to})`
    case 'hreflang_missing': return 'Keine Sprachverweise (hreflang) trotz mehrerer Sprachen'
    case 'slow': return `Lädt langsam (${p.ms} ms für das HTML)`
    case 'heavy': return `HTML sehr groß (${p.kb} KB)`
    case 'pagespeed': return `PageSpeed mobil nur ${p.score} von 100${p.lcp ? ` (größtes Element nach ${p.lcp})` : ''}`
  }
}

export function pageIssues(pages: SeoPage[], opts: { multilingual: boolean, alternates?: Set<string>, home?: string }): SeoIssue[] {
  const out: SeoIssue[] = []
  const titles = new Map<string, string>()
  for (const p of pages) {
    if (p.status !== 200) continue
    const isHome = opts.home ? keyOf(p.url) === keyOf(opts.home) : false
    if (p.noindex) out.push(issue('noindex', isHome ? 3 : 2, p.url))
    if (!p.title) out.push(issue('title_missing', 3, p.url))
    else if (p.title.length > TITLE_MAX) out.push(issue('title_long', 2, p.url, { len: p.title.length }))
    if (p.title && !p.noindex) {
      const other = titles.get(p.title.toLowerCase())
      if (other) out.push(issue('title_duplicate', 2, p.url, { other: pathOf(other) }))
      else titles.set(p.title.toLowerCase(), p.url)
    }
    if (!p.description) out.push(issue('desc_missing', 2, p.url))
    else if (p.description.length > DESC_MAX) out.push(issue('desc_long', 1, p.url, { len: p.description.length }))
    if (!p.h1Count) out.push(issue('h1_missing', 2, p.url))
    else if (p.h1Count > 1) out.push(issue('h1_multiple', 1, p.url, { n: p.h1Count }))
    if (p.imgNoAlt) out.push(issue('img_alt', 1, p.url, { n: p.imgNoAlt }))
    if (p.words < THIN_WORDS && !isLegalPage(p.url)) out.push(issue('thin', 1, p.url, { words: p.words }))
    if (!p.canonical) out.push(issue('canonical_missing', 1, p.url))
    else if (keyOf(p.canonical) !== keyOf(p.url)) out.push(issue('canonical_other', 1, p.url, { to: pathOf(p.canonical) }))
    if (opts.multilingual && !p.hreflang && !opts.alternates?.has(keyOf(p.url))) out.push(issue('hreflang_missing', 2, p.url))
    if (p.ms > SLOW_MS) out.push(issue('slow', 2, p.url, { ms: p.ms }))
    if (p.bytes > HEAVY_BYTES) out.push(issue('heavy', 1, p.url, { kb: Math.round(p.bytes / 1024) }))
  }
  return out
}

export function sortIssues(list: SeoIssue[]): SeoIssue[] {
  return [...list].sort((a, b) => b.severity - a.severity || SEO_CODES.indexOf(a.code) - SEO_CODES.indexOf(b.code) || a.url.localeCompare(b.url))
}

async function pagespeed(url: string, key: string, f: FetchLike): Promise<{ score: number, lcp: string | null } | null> {
  try {
    const u = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed')
    u.searchParams.set('url', url)
    u.searchParams.set('strategy', 'mobile')
    u.searchParams.set('category', 'performance')
    u.searchParams.set('key', key)
    const res = await f(u.toString(), { method: 'GET', signal: AbortSignal.timeout(90_000) })
    if (!res.ok) return null
    const data = await res.json() as { lighthouseResult?: { categories?: { performance?: { score?: number } }, audits?: Record<string, { displayValue?: string }> } }
    const score = data.lighthouseResult?.categories?.performance?.score
    if (typeof score !== 'number') return null
    return { score: Math.round(score * 100), lcp: data.lighthouseResult?.audits?.['largest-contentful-paint']?.displayValue?.replace(/\s/g, ' ') ?? null }
  }
  catch {
    return null
  }
}

export async function auditSite(startUrl: string, opts: { maxPages?: number, fetchImpl?: FetchLike, languages?: string[], pagespeedKey?: string | null, delayMs?: number } = {}): Promise<SeoAuditResult> {
  const f = opts.fetchImpl ?? fetch
  const maxPages = opts.maxPages ?? SEO_MAX_PAGES
  const delay = opts.delayMs ?? 250
  const checkedAt = new Date().toISOString()
  let start: URL
  try {
    start = new URL(/^https?:\/\//i.test(startUrl) ? startUrl : `https://${startUrl}`)
  }
  catch {
    return { url: startUrl, checkedAt, pages: [], issues: [], linksChecked: 0, pagespeed: null, error: 'Ungültige Adresse' }
  }
  const pause = () => (delay ? new Promise(r => setTimeout(r, delay)) : Promise.resolve())
  let robots = ''
  try {
    const r = await fetchTimed(`${start.origin}/robots.txt`, f, 'GET', 5000)
    if (r.status === 200 && !/html/i.test(r.type)) robots = r.html
  }
  catch {}
  if (!robotsAllows(robots, start.pathname)) return { url: start.href, checkedAt, pages: [], issues: [], linksChecked: 0, pagespeed: null, error: 'robots.txt erlaubt den Abruf nicht' }

  const pages: SeoPage[] = []
  const issues: SeoIssue[] = []
  const seen = new Set<string>()
  const linkedFrom = new Map<string, string>()
  const queue: string[] = [start.href]
  let origin = start.origin
  let sitemap: { urls: string[], alternates: Set<string> } | null = null
  let error: string | null = null
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!
    const k = keyOf(url)
    if (seen.has(k)) continue
    seen.add(k)
    if (!robotsAllows(robots, new URL(url).pathname)) continue
    let r: Fetched
    try {
      r = await fetchTimed(url, f)
    }
    catch (err) {
      if (!pages.length) {
        error = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError' ? 'Zeitüberschreitung' : (err as Error).message.slice(0, 200)
        break
      }
      issues.push(issue('http_error', 3, url, { status: 'keine Antwort', ...(linkedFrom.get(k) ? { from: pathOf(linkedFrom.get(k)!) } : {}) }))
      continue
    }
    if (!pages.length) {
      origin = new URL(r.url).origin
      if (r.status >= 400) {
        error = `Startseite antwortet mit Fehler ${r.status}`
        break
      }
      sitemap = await readSitemap(origin, robots, f)
      for (const u of sitemap.urls) queue.push(u)
    }
    seen.add(keyOf(r.url))
    if (r.status >= 400) {
      issues.push(issue('http_error', 3, url, { status: r.status, ...(linkedFrom.get(k) ? { from: pathOf(linkedFrom.get(k)!) } : {}) }))
      await pause()
      continue
    }
    if (r.type && !/html/i.test(r.type)) continue
    const p = analyzePage(r.html, r.url, { status: r.status, ms: r.ms, bytes: r.bytes, robotsHeader: r.robotsHeader })
    const { links, ...page } = p
    pages.push(page)
    for (const l of links) {
      const lk = keyOf(l)
      if (!linkedFrom.has(lk)) linkedFrom.set(lk, r.url)
      if (!seen.has(lk) && new URL(l).origin === origin) queue.push(l)
    }
    await pause()
  }

  let linksChecked = 0
  const unchecked = [...linkedFrom.entries()].filter(([k]) => !seen.has(k)).slice(0, MAX_LINK_CHECKS)
  for (const [k, from] of unchecked) {
    let url = k
    if (!url.startsWith(origin)) continue
    if (!robotsAllows(robots, new URL(url).pathname)) continue
    try {
      let r = await fetchTimed(url, f, 'HEAD', 8000)
      if (r.status === 405 || r.status === 501) r = await fetchTimed(url, f, 'GET', 8000)
      url = r.url
      linksChecked++
      if (r.status >= 400) issues.push(issue('http_error', 3, k, { status: r.status, from: pathOf(from) }))
    }
    catch {}
    await pause()
  }

  const multilingual = (opts.languages?.length ?? 0) > 1 || pages.some(p => p.hreflang > 0) || (sitemap?.alternates.size ?? 0) > 0 || new Set(pages.map(p => p.lang?.slice(0, 2).toLowerCase()).filter(Boolean)).size > 1
  issues.push(...pageIssues(pages, { multilingual, alternates: sitemap?.alternates, home: pages[0]?.url }))
  let ps: SeoAuditResult['pagespeed'] = null
  if (opts.pagespeedKey && pages[0]) {
    ps = await pagespeed(pages[0].url, opts.pagespeedKey, f)
    if (ps && ps.score < 90) issues.push(issue('pagespeed', ps.score < 50 ? 3 : 2, pages[0].url, { score: ps.score, ...(ps.lcp ? { lcp: ps.lcp } : {}) }))
  }
  return { url: start.href, checkedAt, pages, issues: sortIssues(issues), linksChecked, pagespeed: ps, error }
}

const LEGAL = /(^|[/_-])(impressum|imprint|datenschutz|privacy|datenschutzerklaerung|kontakt|contact|agb|terms|legal|cookies?|disclaimer|widerruf)([/_.-]|$)/i

// Pflichtseiten (Impressum, Datenschutz, Kontakt u.ä.) brauchen keinen langen Text.
export function isLegalPage(url: string): boolean {
  return LEGAL.test(pathOf(url))
}

// Was Karte und Aufgaben zeigen: wenig Text auf Pflichtseiten fällt weg (auch in älteren Prüfungen).
export function shownIssues(issues: SeoIssue[]): SeoIssue[] {
  return issues.filter(i => !(i.code === 'thin' && isLegalPage(i.url)))
}

export async function saveAudit(db: Db, projectId: string, r: SeoAuditResult): Promise<void> {
  const row = { projectId, checkedAt: now(), pages: r.pages.length, result: r as unknown as Record<string, unknown> }
  await db.insert(schema.seoAudits).values(row).onConflictDoUpdate({ target: schema.seoAudits.projectId, set: { checkedAt: row.checkedAt, pages: row.pages, result: row.result } })
}

export async function latestAudit(db: Db, projectId: string): Promise<SeoAuditResult | null> {
  const [a] = await db.select().from(schema.seoAudits).where(eq(schema.seoAudits.projectId, projectId))
  return a ? { ...(a.result as unknown as SeoAuditResult), checkedAt: a.checkedAt.toISOString() } : null
}

const SUGGEST: SeoCode[] = ['title_missing', 'title_long', 'title_duplicate', 'desc_missing', 'desc_long', 'h1_missing']

export function taskTitle(i: SeoIssue): string {
  const p = pathOf(i.url)
  switch (i.code) {
    case 'http_error': return `Kaputten Link reparieren: ${p}`
    case 'noindex': return `Prüfen: ${p} ist für Google gesperrt`
    case 'title_missing': return `Seitentitel für ${p} ergänzen`
    case 'title_long': return `Seitentitel von ${p} kürzen`
    case 'title_duplicate': return `Seitentitel von ${p} eindeutig machen`
    case 'desc_missing': return `Meta-Beschreibung für ${p} ergänzen`
    case 'desc_long': return `Meta-Beschreibung von ${p} kürzen`
    case 'h1_missing': return `Hauptüberschrift (H1) auf ${p} ergänzen`
    case 'hreflang_missing': return `Sprachverweise (hreflang) auf ${p} ergänzen`
    case 'slow': return `Ladezeit von ${p} verbessern`
    case 'pagespeed': return 'Ladezeit der Startseite verbessern'
    case 'h1_multiple': return `Nur eine Hauptüberschrift (H1) auf ${p}`
    case 'img_alt': return `Bildbeschreibungen (alt) auf ${p} ergänzen`
    case 'thin': return `Mehr Text auf ${p}`
    case 'canonical_missing': return `Canonical-Link auf ${p} setzen`
    case 'canonical_other': return `Canonical-Link von ${p} prüfen`
    case 'heavy': return `HTML von ${p} verkleinern`
    default: return `${i.label}: ${p}`
  }
}

function cut(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const part = t.slice(0, max + 1)
  const sep = Math.max(part.lastIndexOf(' | '), part.lastIndexOf(' - '))
  if (sep > max * 0.5) return part.slice(0, sep).trim()
  return part.slice(0, part.lastIndexOf(' ') > 0 ? part.lastIndexOf(' ') : max).replace(/[,;:.\s-]+$/, '').trim()
}

export function fallbackSuggestion(i: SeoIssue, page: SeoPage | undefined, projectName: string): string | null {
  if (!page) return null
  switch (i.code) {
    case 'title_long': return page.title ? cut(page.title, TITLE_MAX) : null
    case 'title_missing': return cut(`${page.h1 ?? pathOf(page.url)} | ${projectName}`, TITLE_MAX)
    case 'title_duplicate': return page.h1 ? cut(`${page.h1} | ${projectName}`, TITLE_MAX) : null
    case 'desc_missing': return page.excerpt ? cut(page.excerpt, 155) : null
    case 'desc_long': return page.description ? cut(page.description, 155) : null
    case 'h1_missing': return page.title ? cut(page.title.split(/ [|-] /)[0]!, 70) : null
    default: return null
  }
}

function howTo(i: SeoIssue): string {
  switch (i.code) {
    case 'http_error': return `Der Link auf ${i.params.from ?? 'einer Seite'} führt zu ${pathOf(i.url)} und liefert Fehler ${i.params.status}. Link korrigieren oder entfernen, oder die Seite wiederherstellen bzw. weiterleiten.`
    case 'noindex': return 'Die Seite sagt Google "nicht in die Suche aufnehmen". Wenn sie gefunden werden soll, das noindex im Seitenkopf (meta robots) oder im Header entfernen. Bei Impressum, Datenschutz u.ä. ist das in Ordnung, dann Aufgabe einfach erledigen.'
    case 'title_missing': case 'title_long': case 'title_duplicate': return 'Der Seitentitel (<title>) ist die blaue Überschrift in Google. Er sollte die Seite in höchstens 60 Zeichen eindeutig beschreiben, wichtigster Begriff vorne.'
    case 'desc_missing': case 'desc_long': return 'Die Meta-Beschreibung ist der graue Text unter dem Link in Google. 1-2 Sätze, höchstens 160 Zeichen, sagt worum es geht und lädt zum Klicken ein.'
    case 'h1_missing': return 'Jede Seite braucht genau eine Hauptüberschrift (<h1>), die sagt, worum es geht.'
    case 'hreflang_missing': return 'Bei mehreren Sprachen sollte jede Seite auf ihre Übersetzungen verweisen (<link rel="alternate" hreflang="...">), damit Google die richtige Sprache zeigt.'
    case 'slow': case 'pagespeed': case 'heavy': return 'Langsame Seiten verlieren Besucher und Plätze in Google. Große Bilder verkleinern, unnötige Skripte entfernen, Caching einschalten.'
    case 'h1_multiple': return 'Jede Seite sollte genau eine Hauptüberschrift (<h1>) haben, weitere Überschriften als <h2> bis <h6>.'
    case 'img_alt': return 'Bilder ohne alt-Text sind für Google und Screenreader unsichtbar. Jedes inhaltliche Bild bekommt eine kurze Beschreibung, reine Deko-Bilder alt="".'
    case 'thin': return 'Seiten mit wenig Text ranken schlecht, Google versteht nicht, worum es geht.'
    case 'canonical_missing': case 'canonical_other': return 'Der Canonical-Link (<link rel="canonical">) sagt Google, welche Adresse die Hauptfassung einer Seite ist.'
    default: return i.label
  }
}

const suggestSchema = z.object({ items: z.array(z.object({ i: z.number(), text: z.string() })).catch([]) })

async function suggestTexts(llm: LlmConfig, items: { issue: SeoIssue, page: SeoPage }[], project: Project, usage: ChatResult[], f?: FetchLike): Promise<Map<number, string>> {
  const prompt = [
    `Du bist SEO-Texter für "${project.name}"${project.url ? ` (${project.url})` : ''}. Schreibe für jede Zeile einen konkreten Ersatztext in der Sprache der Seite. Seitentitel höchstens 60 Zeichen, Meta-Beschreibung höchstens 155 Zeichen, H1 höchstens 70 Zeichen. Nichts erfinden, nur was auf der Seite steht. Nur normale Bindestriche.`,
    ...items.map((x, n) => `${n}. ${x.issue.code} auf ${x.page.url} | Titel: ${x.page.title ?? '-'} | Beschreibung: ${x.page.description ?? '-'} | H1: ${x.page.h1 ?? '-'} | Text: ${x.page.excerpt.slice(0, 400)}`),
    'Antworte nur mit JSON: {"items": [{"i": 0, "text": "..."}]}',
  ].join('\n')
  const { data, usage: u } = await chatJson(llm, { fast: true, maxTokens: 800, messages: [{ role: 'user', content: prompt }] }, suggestSchema, f)
  usage.push(...u)
  return new Map(data.items.filter(x => x.text.trim()).map(x => [x.i, x.text.replace(/[–—]/g, '-').trim().slice(0, 200)]))
}

const GROUPS: Record<string, SeoCode[]> = {
  links: ['http_error'],
  noindex: ['noindex'],
  title: ['title_missing', 'title_long', 'title_duplicate'],
  desc: ['desc_missing', 'desc_long'],
  h1: ['h1_missing'],
  hreflang: ['hreflang_missing'],
  speed: ['pagespeed', 'slow', 'heavy'],
  h1multi: ['h1_multiple'],
  img: ['img_alt'],
  thin: ['thin'],
  canonical: ['canonical_missing', 'canonical_other'],
}

export function groupOf(code: SeoCode): string {
  return Object.keys(GROUPS).find(g => GROUPS[g]!.includes(code)) ?? code
}

function groupTitle(g: string, list: SeoIssue[]): string {
  const n = list.length
  if (n === 1) return taskTitle(list[0]!)
  switch (g) {
    case 'links': return `${n} kaputte Links reparieren`
    case 'noindex': return `Prüfen: ${n} Seiten für Google gesperrt`
    case 'title': return `Seitentitel auf ${n} Seiten verbessern`
    case 'desc': return `Meta-Beschreibungen auf ${n} Seiten verbessern`
    case 'h1': return `Hauptüberschrift (H1) auf ${n} Seiten ergänzen`
    case 'hreflang': return `Sprachverweise (hreflang) auf ${n} Seiten ergänzen`
    case 'speed': return `Ladezeit von ${n} Seiten verbessern`
    case 'h1multi': return `Nur eine Hauptüberschrift (H1) auf ${n} Seiten`
    case 'img': return `Bildbeschreibungen (alt) auf ${n} Seiten ergänzen`
    case 'thin': return `Mehr Text auf ${n} Seiten`
    case 'canonical': return `Canonical-Links auf ${n} Seiten setzen`
    default: return `${list[0]!.label}: ${n} Seiten`
  }
}

function groupOrder(g: string): string {
  switch (g) {
    case 'links': return 'Kaputte Links reparieren: Link korrigieren oder entfernen, oder die Zielseite wiederherstellen bzw. weiterleiten.'
    case 'noindex': return 'Prüfen, ob diese Seiten in Google sollen. Wenn ja, noindex (meta robots bzw. X-Robots-Tag) entfernen. Impressum, Datenschutz u.ä. dürfen gesperrt bleiben.'
    case 'title': return 'Seitentitel (<title>) ändern: höchstens 60 Zeichen, je Seite eindeutig, wichtigster Begriff vorne. Vorschläge übernehmen oder sinngemäß verbessern.'
    case 'desc': return 'Meta-Beschreibung (<meta name="description">) setzen: 1-2 Sätze, höchstens 155 Zeichen. Vorschläge übernehmen oder sinngemäß verbessern.'
    case 'h1': return 'Genau eine Hauptüberschrift (<h1>) je Seite setzen. Vorschläge übernehmen oder sinngemäß verbessern.'
    case 'hreflang': return 'Auf jeder Seite <link rel="alternate" hreflang="..."> zu allen Sprachfassungen setzen, gegenseitig und mit x-default.'
    case 'speed': return 'Ladezeit verbessern: große Bilder verkleinern bzw. modern formatieren, unnötige Skripte entfernen, Caching einschalten.'
    case 'h1multi': return 'Je Seite genau eine Hauptüberschrift (<h1>) lassen, die übrigen zu <h2> bzw. passenden Unterüberschriften machen (Aussehen per CSS beibehalten).'
    case 'img': return 'Allen inhaltlichen Bildern ein kurzes, beschreibendes alt-Attribut geben (was ist zu sehen, in der Sprache der Seite), reine Deko-Bilder bekommen alt="".'
    case 'thin': return 'Seiten mit wenig Text sinnvoll ergänzen: kurze Einleitung, worum es geht, Fragen der Besucher beantworten. Nur was stimmt, nichts erfinden. Reine Medien- oder Übersichtsseiten, bei denen mehr Text nicht passt, so lassen und das in der Aufgabe notieren.'
    case 'canonical': return 'Auf jeder Seite <link rel="canonical" href="..."> auf die eigene, endgültige Adresse setzen (https, ohne Parameter). Zeigt er absichtlich auf eine andere Seite (Duplikat), so lassen.'
    default: return 'Auf der Website beheben.'
  }
}

function issueLine(i: SeoIssue, suggestion: string | null): string {
  if (i.code === 'http_error') return `${i.url} liefert Fehler ${i.params.status}${i.params.from ? `, verlinkt auf ${i.params.from}` : ''}`
  return `${i.url}: ${i.label}${suggestion ? ` -> "${suggestion}"` : ''}`
}

// Jede Fund-Art der Prüfung wird zu einer gebündelten Pflege-Aufgabe für Claude. Ist ein Fund in der nächsten Prüfung weg, erledigt sich die Aufgabe.
// Neu angelegt wird nicht, solange eine Aufgabe offen ist, sie nach dieser Prüfung erledigt wurde oder der Mensch sie in den letzten 28 Tagen verworfen hat.
// only: nur diese Gruppe sofort anlegen (Knopf in der Karte), auch wenn sie zuletzt verworfen wurde.
export async function seoTasks(db: Db, ws: Workspace, project: Project, audit: SeoAuditResult, deps: { llm?: LlmConfig | null, fetchImpl?: FetchLike, usage?: ChatResult[], max?: number, only?: string } = {}): Promise<{ created: number, closed: number }> {
  const d = today(ws.timezone)
  const issues = shownIssues(audit.issues).filter(i => !deps.only || groupOf(i.code) === deps.only)
  const groups = new Map<string, SeoIssue[]>()
  for (const i of issues) groups.set(groupOf(i.code), [...(groups.get(groupOf(i.code)) ?? []), i])
  const legacy = new Set(issues.map(i => `seo:${i.code}:${pathOf(i.url)}`))
  const open = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, project.id), like(schema.tasks.origin, 'seo%'), inArray(schema.tasks.status, OPEN_STATUSES)))
  const groupTasks = new Map(open.filter(t => t.origin?.startsWith('seo-group:')).map(t => [t.origin!.slice(10), t]))
  let closed = 0
  if (!deps.only && !audit.error && audit.pages.length) {
    for (const t of open) {
      const gone = t.origin?.startsWith('seo-group:') ? !groups.has(t.origin.slice(10)) : t.origin?.startsWith('seo:') && !legacy.has(t.origin)
      if (!gone) continue
      await db.update(schema.tasks).set({ status: 'erledigt', doneAt: now(), updatedAt: now() }).where(eq(schema.tasks.id, t.id))
      groupTasks.delete(t.origin!.slice(10))
      closed++
    }
  }
  const recent = await db.select({ origin: schema.tasks.origin, status: schema.tasks.status, doneAt: schema.tasks.doneAt, updatedAt: schema.tasks.updatedAt }).from(schema.tasks).where(and(eq(schema.tasks.projectId, project.id), or(like(schema.tasks.origin, 'seo-group:%'), like(schema.tasks.origin, 'seo-drop:%')), or(inArray(schema.tasks.status, OPEN_STATUSES), gte(schema.tasks.updatedAt, new Date(`${addDays(d, -28)}T00:00:00Z`)))))
  const checked = audit.checkedAt && !Number.isNaN(Date.parse(audit.checkedAt)) ? new Date(audit.checkedAt) : now()
  const blocks = (r: typeof recent[number]) => !r.origin?.startsWith('seo-group:') || OPEN_STATUSES.includes(r.status) || r.status === 'verworfen' || (r.doneAt ?? r.updatedAt) >= checked
  const taken = new Set(recent.filter(blocks).map(r => r.origin))
  const max = deps.max ?? 20
  const fresh = [...groups.keys()].filter(g => !groupTasks.has(g) && (deps.only === g || !taken.has(`seo-group:${g}`))).slice(0, max)
  const todo = [...groupTasks.keys()].filter(g => groups.has(g)).concat(fresh)
  const pageOf = (url: string) => audit.pages.find(p => p.url === url)
  const all = todo.flatMap(g => groups.get(g)!.slice(0, ORDER_MAX))
  const texts = new Map<SeoIssue, string>()
  const needs = all.map(issue => ({ issue, page: pageOf(issue.url) })).filter(x => SUGGEST.includes(x.issue.code) && x.page) as { issue: SeoIssue, page: SeoPage }[]
  if (needs.length && deps.llm && llmStatus(deps.llm).configured) {
    try {
      const got = await suggestTexts(deps.llm, needs, project, deps.usage ?? [], deps.fetchImpl)
      needs.forEach((x, k) => {
        const s = got.get(k)
        if (s) texts.set(x.issue, s)
      })
    }
    catch {}
  }
  const suggestionOf = (i: SeoIssue) => {
    const limit = i.code.startsWith('desc') ? 155 : i.code === 'h1_missing' ? 70 : TITLE_MAX
    const t = texts.get(i)
    return t ? cut(t, limit) : SUGGEST.includes(i.code) ? fallbackSuggestion(i, pageOf(i.url), project.name) : null
  }
  const owner = await projectOwner(db, project.id)
  const prefix = `${project.code}-${CATEGORY_CODES.pflege}`
  let created = 0
  for (const g of todo) {
    const list = groups.get(g)!
    const had = groupTasks.get(g)
    const code = had?.code ?? await nextTaskCode(db, ws.id, prefix)
    const lines = list.map(i => issueLine(i, suggestionOf(i)))
    const description = [
      `SEO-Prüfung: ${list.length === 1 ? list[0]!.label : `${list.length} Seiten`}.${list.length === 1 || g !== 'links' ? ` ${howTo(list[0]!)}` : ''}`,
      websiteOrder(project.url, code, groupOrder(g), lines),
    ].join('\n\n')
    const fields = { title: groupTitle(g, list).slice(0, 200), description, targetUrl: list[0]!.url, prio: list.some(i => i.severity >= 3) ? 'P1' as const : list.some(i => i.severity >= 2) ? 'P2' as const : 'P3' as const }
    if (had) await db.update(schema.tasks).set({ ...fields, updatedAt: now() }).where(eq(schema.tasks.id, had.id))
    else {
      await createTask(db, {
        workspaceId: ws.id,
        projectId: project.id,
        code,
        ...fields,
        category: 'pflege',
        channel: 'Website',
        dueDate: d,
        durationMin: 15,
        estimateMin: list.length > 1 ? 30 : 15,
        humanStep: 'Auftrag an Claude Code oder Entwickler geben',
        assigneeUserId: owner,
        origin: `seo-group:${g}`,
      })
      created++
    }
    const merged = open.filter(t => t.origin?.startsWith('seo:') && GROUPS[g]?.includes(t.origin.split(':')[1] as SeoCode) && legacy.has(t.origin))
    if (merged.length) await db.update(schema.tasks).set({ status: 'verworfen', updatedAt: now() }).where(inArray(schema.tasks.id, merged.map(t => t.id)))
  }
  if (deps.only) return { created, closed }
  const { from, to } = searchRange(d)
  const s = await searchSummary(db, project.id, from, to)
  const drop = s.dropped.find(p => !taken.has(`seo-drop:${pathOf(p.page)}`))
  if (drop && created < max + 1) {
    const code = await nextTaskCode(db, ws.id, prefix)
    const before = String(drop.before).replace('.', ',')
    const after = String(drop.now).replace('.', ',')
    const engine = drop.source === 'bing' ? 'Bing' : 'Google'
    await createTask(db, {
      workspaceId: ws.id,
      projectId: project.id,
      code,
      title: `${pathOf(drop.page)} überarbeiten: in ${engine} abgerutscht`.slice(0, 200),
      description: [
        `Die Seite ist in der ${engine}-Suche von Position ${before} auf ${after} gefallen (letzte 2 Wochen gegen die 2 davor).`,
        websiteOrder(project.url, code, `Seite inhaltlich auffrischen, sie ist in ${engine} abgerutscht: aktuelle Angaben, fehlende Fragen der Besucher beantworten, Seitentitel und Meta-Beschreibung prüfen.`, [drop.page]),
      ].join('\n\n'),
      category: 'pflege',
      channel: 'Website',
      dueDate: d,
      durationMin: 30,
      estimateMin: 30,
      prio: 'P2',
      humanStep: 'Auftrag an Claude Code oder Entwickler geben',
      assigneeUserId: owner,
      targetUrl: drop.page,
      origin: `seo-drop:${pathOf(drop.page)}`,
    })
    created++
  }
  return { created, closed }
}

export interface SeoGroupTask { id: string, code: string, status: string }

// Aufgabe je Gruppe für die Karte: offene, sonst die seit der Prüfung erledigte oder verworfene.
export async function seoGroupTasks(db: Db, projectId: string, checkedAt: string | null): Promise<Record<string, SeoGroupTask>> {
  const rows = await db.select({ id: schema.tasks.id, code: schema.tasks.code, status: schema.tasks.status, origin: schema.tasks.origin, updatedAt: schema.tasks.updatedAt }).from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), like(schema.tasks.origin, 'seo-group:%')))
  const since = checkedAt ? new Date(checkedAt) : null
  const out: Record<string, SeoGroupTask & { at: number, open: boolean }> = {}
  for (const r of rows) {
    const open = OPEN_STATUSES.includes(r.status)
    if (!open && (!since || r.updatedAt < since)) continue
    const g = r.origin!.slice(10)
    const had = out[g]
    if (had && (had.open && !open || had.open === open && had.at >= r.updatedAt.getTime())) continue
    out[g] = { id: r.id, code: r.code, status: r.status, at: r.updatedAt.getTime(), open }
  }
  return Object.fromEntries(Object.entries(out).map(([g, t]) => [g, { id: t.id, code: t.code, status: t.status }]))
}
