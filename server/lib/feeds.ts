import { and, desc, eq, gte, inArray, ne, or, sql } from 'drizzle-orm'
import { stripUtm } from '../../shared/utils/utm'
import type { FeedItemStatus, ProjectFeed } from '../db/schema'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import { assertPublicHost, safeFetch, SITE_UA } from './site'
import { agentReady, withRun, type RunOutcome } from './agent'
import { timeSuggester } from './best-times'
import { activeStrategy, projectOwner } from './strategy'
import { socialTarget } from './publish'
import { createTask } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface FeedEntry {
  guid: string | null
  link: string
  title: string | null
  summary: string | null
  publishedAt: string | null
}

export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'sitemap'
  title: string | null
  language: string | null
  entries: FeedEntry[]
}

export class FeedError extends Error {}

const MAX_BYTES = 2_000_000
const FIRST_DAYS = 7
const MAX_AGE_DAYS = 30
const PER_RUN = 3
export const MAX_FEEDS = 5

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

function text(raw: string | undefined | null): string | null {
  if (!raw) return null
  const cdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  const plain = decode(decode(cdata).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  return plain || null
}

function tag(block: string, name: string): string | undefined {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)?.[1]
}

function date(raw: string | null): string | null {
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

function absolute(href: string | null, base: string): string | null {
  if (!href) return null
  try {
    const u = new URL(href, base)
    return /^https?:$/.test(u.protocol) ? u.href : null
  }
  catch {
    return null
  }
}

export function normLink(url: string): string {
  try {
    const u = new URL(stripUtm(url))
    u.hash = ''
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.host}${path}${u.search}`
  }
  catch {
    return url.trim()
  }
}

export function parseFeed(xml: string, base: string): ParsedFeed | null {
  const head = xml.slice(0, 3000)
  if (/<urlset[\s>]/i.test(head)) {
    const entries: FeedEntry[] = []
    for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
      const link = absolute(text(tag(m[1]!, 'loc')), base)
      if (!link) continue
      entries.push({ guid: null, link, title: null, summary: null, publishedAt: date(text(tag(m[1]!, 'lastmod'))) })
    }
    return { kind: 'sitemap', title: null, language: null, entries }
  }
  if (/<feed[\s>]/i.test(head) && /2005\/Atom/i.test(head)) {
    const entries: FeedEntry[] = []
    for (const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
      const b = m[1]!
      const links = [...b.matchAll(/<link\b([^>]*)\/?>/gi)].map(l => l[1]!)
      const alt = links.find(l => /rel=["']alternate["']/i.test(l)) ?? links.find(l => !/rel=/i.test(l)) ?? links[0]
      const link = absolute(alt ? decode(/href=["']([^"']+)["']/i.exec(alt)?.[1] ?? '') : null, base)
      if (!link) continue
      entries.push({ guid: text(tag(b, 'id')), link, title: text(tag(b, 'title')), summary: text(tag(b, 'summary') ?? tag(b, 'content'))?.slice(0, 600) ?? null, publishedAt: date(text(tag(b, 'published') ?? tag(b, 'updated'))) })
    }
    const top = xml.replace(/<entry[\s\S]*$/i, '')
    return { kind: 'atom', title: text(tag(top, 'title')), language: /xml:lang=["']([a-z]{2})/i.exec(head)?.[1]?.toLowerCase() ?? null, entries }
  }
  if (/<rss[\s>]|<rdf:RDF[\s>]/i.test(head)) {
    const entries: FeedEntry[] = []
    for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
      const b = m[1]!
      const guid = text(tag(b, 'guid'))
      const link = absolute(text(tag(b, 'link')), base) ?? (guid && /^https?:\/\//.test(guid) ? guid : null)
      if (!link) continue
      entries.push({ guid, link, title: text(tag(b, 'title')), summary: text(tag(b, 'description') ?? tag(b, 'content:encoded'))?.slice(0, 600) ?? null, publishedAt: date(text(tag(b, 'pubDate') ?? tag(b, 'dc:date'))) })
    }
    const top = xml.replace(/<item[\s>][\s\S]*$/i, '')
    return { kind: 'rss', title: text(tag(top, 'title')), language: text(tag(top, 'language'))?.slice(0, 2).toLowerCase() ?? null, entries }
  }
  return null
}

export function feedLinkInHtml(html: string, base: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const l = m[0]
    if (!/rel=["']?alternate/i.test(l) || !/type=["']application\/(rss|atom)\+xml["']/i.test(l)) continue
    const href = /href=["']([^"']+)["']/i.exec(l)?.[1]
    const abs = absolute(href ? decode(href) : null, base)
    if (abs) return abs
  }
  return null
}

async function getText(url: string, f: FetchLike): Promise<{ status: number, body: string, url: string, type: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await safeFetch(url, { method: 'GET', signal: ctrl.signal, headers: { 'User-Agent': SITE_UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5' } }, f)
    const body = (await res.text()).slice(0, MAX_BYTES)
    return { status: res.status, body, url: res.url || url, type: res.headers.get('content-type') ?? '' }
  }
  catch (err) {
    throw new FeedError((err as Error).name === 'AbortError' ? 'Zeitüberschreitung' : `Nicht erreichbar: ${(err as Error).message.slice(0, 120)}`)
  }
  finally {
    clearTimeout(timer)
  }
}

export async function fetchFeed(url: string, f: FetchLike = fetch, discover = true): Promise<ParsedFeed & { url: string }> {
  const r = await getText(url, f)
  if (r.status >= 400) throw new FeedError(`HTTP ${r.status}`)
  const parsed = parseFeed(r.body, r.url)
  if (parsed) return { ...parsed, url }
  const alt = discover ? feedLinkInHtml(r.body, r.url) : null
  if (alt && alt !== url) return fetchFeed(alt, f, false)
  throw new FeedError('Kein RSS-, Atom-Feed oder Sitemap gefunden')
}

export function sitemapEntries(entries: FeedEntry[], prefix: string | null | undefined): FeedEntry[] {
  const p = prefix ? normLink(prefix) : null
  return entries.filter((e) => {
    const n = normLink(e.link)
    return !!e.publishedAt && (!p || (n.startsWith(`${p}/`) && n !== p))
  })
}

export function publicFeeds(feeds: ProjectFeed[] | null | undefined) {
  return (feeds ?? []).map(f => ({ url: f.url, title: f.title ?? null, prefix: f.prefix ?? null, addedAt: f.addedAt, syncedAt: f.syncedAt ?? null, error: f.error ?? null, newest: f.newest ?? null }))
}

export async function saveFeeds(db: DbOrTx, projectId: string, feeds: ProjectFeed[]): Promise<void> {
  await db.update(schema.projects).set({ setup: sql`coalesce(${schema.projects.setup}, '{}'::jsonb) || jsonb_build_object('feeds', ${JSON.stringify(feeds)}::jsonb)` }).where(eq(schema.projects.id, projectId))
}

export async function loadFeeds(db: DbOrTx, projectId: string): Promise<ProjectFeed[]> {
  const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, projectId))
  return p?.setup?.feeds ?? []
}

export async function addFeed(db: Db, project: Project, input: { url: string }, f: FetchLike = fetch): Promise<{ feed: ProjectFeed, entries: number }> {
  let start: URL
  try {
    start = new URL(/^https?:\/\//i.test(input.url.trim()) ? input.url.trim() : `https://${input.url.trim()}`)
  }
  catch {
    throw new FeedError('Ungültige Adresse')
  }
  const parsed = await fetchFeed(start.href, f)
  const feeds = await loadFeeds(db, project.id)
  if (feeds.some(x => normLink(x.url) === normLink(parsed.url))) throw new FeedError('Feed ist schon eingetragen')
  if (feeds.length >= MAX_FEEDS) throw new FeedError(`Höchstens ${MAX_FEEDS} Feeds je Projekt`)
  const blog = project.setup?.blog
  const prefix = parsed.kind === 'sitemap' && blog && new URL(blog).hostname.replace(/^www\./, '') === new URL(parsed.url).hostname.replace(/^www\./, '') ? blog : null
  const entries = parsed.kind === 'sitemap' ? sitemapEntries(parsed.entries, prefix) : parsed.entries
  const feed: ProjectFeed = { url: parsed.url, title: parsed.title?.slice(0, 120) ?? null, prefix, addedAt: now().toISOString(), syncedAt: null, error: null, newest: newestTitle(entries) }
  await saveFeeds(db, project.id, [...feeds, feed])
  return { feed, entries: entries.length }
}

export async function removeFeed(db: Db, projectId: string, url: string): Promise<boolean> {
  const feeds = await loadFeeds(db, projectId)
  const rest = feeds.filter(x => x.url !== url)
  if (rest.length === feeds.length) return false
  await saveFeeds(db, projectId, rest)
  return true
}

function newestTitle(entries: FeedEntry[]): string | null {
  const e = [...entries].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))[0]
  return e ? (e.title ?? e.link).slice(0, 160) : null
}

async function pageInfo(url: string, f: FetchLike): Promise<{ title: string | null, summary: string | null }> {
  try {
    const r = await getText(url, f)
    if (r.status >= 400) return { title: null, summary: null }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.body)?.[1]
    const desc = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(r.body)?.[1] ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(r.body)?.[1]
    return { title: text(title)?.slice(0, 200) ?? null, summary: desc ? decode(desc).slice(0, 600) : null }
  }
  catch {
    return { title: null, summary: null }
  }
}

export interface FeedSyncResult {
  feeds: { url: string, entries: number, created: number, error: string | null, newest: string | null }[]
  created: number
  skipped: number
  tasks: string[]
}

type Decision = FeedItemStatus

export async function socialChannel(db: DbOrTx, ws: Workspace, project: Project): Promise<{ key: string | null, name: string, time: string | null } | null> {
  const st = await activeStrategy(db, project.id)
  const ch = (st?.channels ?? []).filter(c => c.category === 'social' && c.active).sort((a, b) => b.weight - a.weight)[0]
  if (ch) return { key: ch.key, name: ch.name, time: ch.time ?? null }
  return socialTarget(ws, project)?.platforms.some(p => p.postable) ? { key: null, name: 'Social Media', time: null } : null
}

async function ownLinks(db: DbOrTx, projectId: string): Promise<{ own: Set<string>, social: Set<string> }> {
  const since = new Date(now().getTime() - 180 * 86_400_000)
  const links = await db.select({ url: schema.taskLinks.url, category: schema.tasks.category, draftKind: schema.tasks.draftKind }).from(schema.taskLinks)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskLinks.taskId))
    .where(and(eq(schema.taskLinks.projectId, projectId), gte(schema.taskLinks.postedAt, since)))
  const own = new Set(links.filter(l => l.category !== 'social').map(l => normLink(l.url)))
  const socials = await db.select({ targetUrl: schema.tasks.targetUrl, description: schema.tasks.description }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.category, 'social'), ne(schema.tasks.status, 'verworfen'), gte(schema.tasks.createdAt, since)))
  const social = new Set<string>()
  for (const t of socials) {
    if (t.targetUrl) social.add(normLink(t.targetUrl))
    for (const m of (t.description ?? '').matchAll(/https?:\/\/[^\s)"'<>]+/g)) social.add(normLink(m[0]))
  }
  return { own, social }
}

export type TimeSuggest = (date: string, preferred: string | null) => Promise<{ date: string, time: string | null }>

export async function syncProjectFeeds(db: Db, ws: Workspace, project: Project, deps: { fetchImpl?: FetchLike, log?: string[], suggest?: TimeSuggest, draft?: boolean } = {}): Promise<FeedSyncResult> {
  const f = deps.fetchImpl ?? fetch
  const feeds = await loadFeeds(db, project.id)
  const out: FeedSyncResult = { feeds: [], created: 0, skipped: 0, tasks: [] }
  if (!feeds.length) return out
  const d = today(ws.timezone)
  const channel = await socialChannel(db, ws, project)
  const owner = await projectOwner(db, project.id)
  const { own, social } = await ownLinks(db, project.id)
  const next: ProjectFeed[] = []
  let budget = PER_RUN
  for (const feed of feeds) {
    const row = { url: feed.url, entries: 0, created: 0, error: null as string | null, newest: feed.newest ?? null }
    try {
      const parsed = await fetchFeed(feed.url, f, false)
      const entries = (parsed.kind === 'sitemap' ? sitemapEntries(parsed.entries, feed.prefix) : parsed.entries).slice(0, 100)
      row.entries = entries.length
      row.newest = newestTitle(entries)
      const keys = entries.map(e => normLink(e.link))
      const guids = entries.map(e => e.guid).filter((g): g is string => !!g)
      const seenRows = keys.length ? await db.select({ link: schema.feedItems.link, guid: schema.feedItems.guid }).from(schema.feedItems).where(and(eq(schema.feedItems.projectId, project.id), or(inArray(schema.feedItems.link, keys), guids.length ? inArray(schema.feedItems.guid, guids) : sql`false`))) : []
      const seen = new Set([...seenRows.map(r => r.link), ...seenRows.map(r => r.guid).filter(Boolean)])
      const first = !feed.syncedAt
      const fresh = entries.filter(e => !seen.has(normLink(e.link)) && !(e.guid && seen.has(e.guid))).sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))
      for (const e of fresh) {
        const link = normLink(e.link)
        if (seen.has(link)) continue
        seen.add(link)
        const age = e.publishedAt ? (now().getTime() - Date.parse(e.publishedAt)) / 86_400_000 : 0
        let status: Decision = 'aufgabe'
        if ((first && (age > FIRST_DAYS || !e.publishedAt)) || age > MAX_AGE_DAYS) status = 'alt'
        else if (social.has(link)) status = own.has(link) ? 'eigen' : 'doppelt'
        else if (!channel) status = 'ohne_kanal'
        if (status === 'aufgabe' && budget <= 0) continue
        let taskId: string | null = null
        if (status === 'aufgabe') {
          const info = !e.title || !e.summary ? await pageInfo(e.link, f) : { title: null, summary: null }
          const title = e.title ?? info.title ?? new URL(e.link).pathname.split('/').filter(Boolean).pop() ?? e.link
          const summary = e.summary ?? info.summary
          const when = deps.suggest ? await deps.suggest(d, channel!.time) : { date: d, time: channel!.time }
          const lang = parsed.language && project.languages.includes(parsed.language) ? parsed.language : null
          const t = await createTask(db, {
            workspaceId: ws.id,
            projectId: project.id,
            title: `Social-Post zum Artikel: ${title}`.slice(0, 200),
            description: [
              `Neuer Eintrag im Feed ${feed.title ?? new URL(feed.url).hostname}: "${title}"`,
              `Link: ${e.link}`,
              summary ? `Auszug: ${summary}` : '',
              own.has(link) ? 'Der Artikel wurde über Aimarage veröffentlicht, ein Social-Post dazu fehlt noch.' : '',
              'Kurz und konkret teilen: worum es geht und warum es sich lohnt, mit genau diesem Link. Nichts erfinden, was nicht im Auszug steht.',
            ].filter(Boolean).join('\n'),
            category: 'social',
            channel: channel!.name,
            language: lang,
            dueDate: when.date,
            dueTime: when.time,
            agentStep: 'Beitrag zum neuen Artikel entwerfen',
            humanStep: 'Prüfen und freigeben',
            assigneeUserId: owner,
            draftKind: 'post',
            targetUrl: e.link,
            strategyChannel: when.date === d ? channel!.key : null,
            origin: 'rss',
          })
          taskId = t.id
          budget--
          row.created++
          out.created++
          out.tasks.push(t.code)
          social.add(link)
          await logActivity(db, { workspaceId: ws.id, projectId: project.id, taskId: t.id, actor: 'agent', action: 'feed_task_created', detail: { title: t.title }, at: now() })
          if (deps.draft !== false) await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: t.id, hold: true }, dedupeKey: `draft_task:${t.id}:${d}` })
        }
        else {
          out.skipped++
        }
        await db.insert(schema.feedItems).values({ workspaceId: ws.id, projectId: project.id, feedUrl: feed.url, guid: e.guid, link, title: e.title?.slice(0, 300) ?? null, publishedAt: e.publishedAt ? new Date(e.publishedAt) : null, status, taskId, createdAt: now() }).onConflictDoNothing()
      }
      next.push({ ...feed, title: feed.title ?? parsed.title?.slice(0, 120) ?? null, syncedAt: now().toISOString(), error: null, newest: row.newest })
    }
    catch (err) {
      row.error = (err as Error).message.slice(0, 200)
      deps.log?.push(`Feed ${feed.url}: ${row.error}`)
      next.push({ ...feed, error: row.error })
    }
    out.feeds.push(row)
  }
  const current = await loadFeeds(db, project.id)
  await saveFeeds(db, project.id, current.map(c => next.find(n => n.url === c.url) ?? c))
  return out
}

export async function syncAllFeeds(db: Db, ws: Workspace, opts: { projectId?: string | null, fetchImpl?: FetchLike, log?: string[], suggest?: (project: Project) => TimeSuggest, draft?: boolean } = {}): Promise<{ projects: number, created: number, skipped: number, errors: string[] }> {
  const rows = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), sql`${schema.projects.archivedAt} is null`, sql`jsonb_array_length(coalesce(${schema.projects.setup}->'feeds', '[]'::jsonb)) > 0`, opts.projectId ? eq(schema.projects.id, opts.projectId) : undefined))
  const res = { projects: 0, created: 0, skipped: 0, errors: [] as string[] }
  for (const p of rows) {
    const r = await syncProjectFeeds(db, ws, p, { fetchImpl: opts.fetchImpl, log: opts.log, suggest: opts.suggest?.(p), draft: opts.draft })
    res.projects++
    res.created += r.created
    res.skipped += r.skipped
    for (const x of r.feeds) if (x.error) res.errors.push(`${p.name}: ${x.error}`)
  }
  return res
}

export async function recentFeedItems(db: DbOrTx, projectId: string, limit = 8) {
  const rows = await db.select({ title: schema.feedItems.title, link: schema.feedItems.link, status: schema.feedItems.status, createdAt: schema.feedItems.createdAt, taskId: schema.feedItems.taskId, code: schema.tasks.code })
    .from(schema.feedItems).leftJoin(schema.tasks, eq(schema.tasks.id, schema.feedItems.taskId))
    .where(and(eq(schema.feedItems.projectId, projectId), ne(schema.feedItems.status, 'alt')))
    .orderBy(desc(schema.feedItems.createdAt)).limit(limit)
  return rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() }))
}

export async function runFeedSync(db: Db, ws: Workspace, projectId: string | null = null, fetchImpl?: FetchLike): Promise<RunOutcome> {
  return withRun(db, ws, 'feed_sync', { projectId }, async (ctx) => {
    const r = await syncAllFeeds(db, ws, { projectId, fetchImpl, log: ctx.log, draft: agentReady(ws), suggest: p => timeSuggester(db, ws, p) })
    if (!r.projects) return { status: 'skipped', summary: 'Kein Feed eingetragen' }
    if (!r.created && !r.errors.length) return { status: 'skipped', summary: `Feeds geprüft (${r.projects} Projekte), nichts Neues` }
    return { status: 'ok', summary: `Feeds geprüft: ${r.created} neue Social-Aufgaben${r.skipped ? `, ${r.skipped} übersprungen` : ''}${r.errors.length ? `, Fehler: ${r.errors[0]}` : ''}` }
  })
}
