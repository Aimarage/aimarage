import { and, desc, eq, inArray, isNull, like, lte, or, sql } from 'drizzle-orm'
import { plural } from '../../shared/utils/plural'
import { addDays } from '../../shared/utils/dates'
import { OPEN_STATUSES } from '../../shared/utils/domain'
import { checkKind, openFirst, seoGroupOf, type CheckItem, type CheckKind, type SeoCheckGroup } from '../../shared/utils/task-check'
import { isHttpUrl } from '../../shared/utils/url'
import { logActivity } from './activity'
import { withRun, type RunOutcome } from './agent'
import { today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { braveKey, braveSearch, siteQuery } from './platforms/brave'
import { RedditClient, redditApp, subredditsOf, userAgent } from './reddit'
import { analyzePage, DESC_MAX, fetchTimed, keyOf, latestAudit, pathOf, shownIssues, THIN_WORDS, TITLE_MAX, type SeoAuditResult, type SeoCode, type SeoPage } from './seo-audit'
import { updateTask, type TaskRow } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface CheckResult {
  kind: CheckKind | null
  ok: boolean
  items: CheckItem[]
  needLink?: boolean
  postedUrl?: string | null
}

export interface CheckOptions {
  fetchImpl?: FetchLike
  link?: string | null
  search?: boolean
  auto?: boolean
}

const MAX_PAGES = 30

// SEO: Zeilen der Aufgabe (Seite + Art) aus Beschreibung und letzter Prüfung

interface SeoLine {
  url: string
  code: SeoCode
  from?: string | null
  other?: string | null
}

const LABELS: [RegExp, SeoCode][] = [
  [/^Seitentitel fehlt/, 'title_missing'],
  [/^Seitentitel zu lang/, 'title_long'],
  [/^Gleicher Seitentitel wie/, 'title_duplicate'],
  [/^Meta-Beschreibung fehlt/, 'desc_missing'],
  [/^Meta-Beschreibung zu lang/, 'desc_long'],
  [/^Hauptüberschrift \(H1\) fehlt/, 'h1_missing'],
  [/^Keine Sprachverweise/, 'hreflang_missing'],
  [/^Für Google gesperrt/, 'noindex'],
  [/^\d+ Hauptüberschriften/, 'h1_multiple'],
  [/^\d+ Bilder ohne/, 'img_alt'],
  [/^Wenig Text/, 'thin'],
  [/^Kein Canonical/, 'canonical_missing'],
  [/^Canonical zeigt/, 'canonical_other'],
]

const GROUP_CODES: Record<SeoCheckGroup, SeoCode[]> = {
  links: ['http_error'],
  noindex: ['noindex'],
  title: ['title_missing', 'title_long', 'title_duplicate'],
  desc: ['desc_missing', 'desc_long'],
  h1: ['h1_missing'],
  hreflang: ['hreflang_missing'],
  h1multi: ['h1_multiple'],
  img: ['img_alt'],
  thin: ['thin'],
  canonical: ['canonical_missing', 'canonical_other'],
}

const FALLBACK: Record<SeoCheckGroup, SeoCode> = { links: 'http_error', noindex: 'noindex', title: 'title_long', desc: 'desc_missing', h1: 'h1_missing', hreflang: 'hreflang_missing', h1multi: 'h1_multiple', img: 'img_alt', thin: 'thin', canonical: 'canonical_missing' }

export function seoLines(description: string | null, group: SeoCheckGroup, audit: SeoAuditResult | null, targetUrl: string | null, legacyCode?: string | null): SeoLine[] {
  const out: SeoLine[] = []
  const seen = new Set<string>()
  const add = (l: SeoLine) => {
    const k = `${l.code}|${keyOf(l.url)}`
    if (seen.has(k) || !GROUP_CODES[group].includes(l.code)) return
    seen.add(k)
    out.push(l)
  }
  for (const raw of (description ?? '').split('\n')) {
    const err = /^- (https?:\/\/\S+) liefert Fehler (\d+)(?:, verlinkt auf (\S+))?\s*$/.exec(raw)
    if (err) {
      add({ url: err[1]!, code: 'http_error', from: err[3] ?? null })
      continue
    }
    const m = /^- (https?:\/\/\S+?): (.+)$/.exec(raw)
    if (!m) continue
    const hit = LABELS.find(([re]) => re.test(m[2]!))
    if (!hit) continue
    add({ url: m[1]!, code: hit[1], other: hit[1] === 'title_duplicate' ? /wie (\S+)/.exec(m[2]!)?.[1]?.replace(/[,.)]+$/, '') ?? null : null })
  }
  if (audit && (/weitere Seiten/.test(description ?? '') || !out.length)) {
    for (const i of shownIssues(audit.issues)) {
      add({ url: i.url, code: i.code, from: typeof i.params.from === 'string' ? i.params.from : null, other: typeof i.params.other === 'string' ? i.params.other : null })
    }
  }
  if (!out.length && targetUrl && isHttpUrl(targetUrl)) {
    const code = legacyCode && GROUP_CODES[group].includes(legacyCode as SeoCode) ? legacyCode as SeoCode : FALLBACK[group]
    add({ url: targetUrl, code })
  }
  return out.slice(0, MAX_PAGES)
}

type Loaded = { page: SeoPage & { links: string[] }, lastModified: string | null } | { error: string }

function pageLoader(f: FetchLike) {
  const cache = new Map<string, Promise<Loaded>>()
  return (url: string): Promise<Loaded> => {
    const k = keyOf(url)
    let p = cache.get(k)
    if (!p) {
      p = fetchTimed(url, f, 'GET', 12_000).then(
        r => ({ page: analyzePage(r.html, r.url, { status: r.status, ms: r.ms, bytes: r.bytes, robotsHeader: r.robotsHeader }), lastModified: r.lastModified }),
        (err: Error) => ({ error: err.message.slice(0, 80) }),
      )
      cache.set(k, p)
    }
    return p
  }
}

function absolute(path: string, base: string): string | null {
  try {
    return new URL(path, base).href
  }
  catch {
    return null
  }
}

async function inBatches<T, R>(list: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < list.length; i += size) out.push(...await Promise.all(list.slice(i, i + size).map(fn)))
  return out
}

function unreachable(path: string, l: Loaded): string {
  return 'error' in l ? `${path} nicht erreichbar (${l.error})` : `${path} nicht erreichbar (Fehler ${l.page.status})`
}

async function checkSeoLine(l: SeoLine, load: (u: string) => Promise<Loaded>): Promise<CheckItem> {
  const path = pathOf(l.url)
  const got = await load(l.url)
  if (l.code === 'http_error') {
    if (!('error' in got) && got.page.status < 400) return { text: `${path} lädt wieder (${got.page.status})`, done: true }
    const fromUrl = l.from ? absolute(l.from, l.url) : null
    if (fromUrl) {
      const from = await load(fromUrl)
      if (!('error' in from) && from.page.status === 200 && !from.page.links.some(x => keyOf(x) === keyOf(l.url))) return { text: `Link auf ${path} von ${pathOf(fromUrl)} entfernt`, done: true }
    }
    return { text: `${path} liefert weiter ${'error' in got ? 'keine Antwort' : `Fehler ${got.page.status}`}${l.from ? `, verlinkt auf ${l.from}` : ''}`, done: false }
  }
  if ('error' in got || got.page.status !== 200) return { text: unreachable(path, got), done: false }
  const p = got.page
  switch (l.code) {
    case 'noindex': return p.noindex ? { text: `${path} weiter für Google gesperrt (noindex)`, done: false } : { text: `${path} für Google offen`, done: true }
    case 'title_missing': return p.title ? { text: `Titel auf ${path} vorhanden (${p.title.length} Zeichen)`, done: true } : { text: `Titel auf ${path} fehlt`, done: false }
    case 'title_long':
      if (!p.title) return { text: `Titel auf ${path} fehlt`, done: false }
      return p.title.length > TITLE_MAX ? { text: `Titel auf ${path} hat ${p.title.length} Zeichen (gut sind bis ${TITLE_MAX})`, done: false } : { text: `Titel auf ${path} hat ${p.title.length} Zeichen`, done: true }
    case 'title_duplicate': {
      if (!p.title) return { text: `Titel auf ${path} fehlt`, done: false }
      const otherUrl = l.other ? absolute(l.other, l.url) : null
      const other = otherUrl ? await load(otherUrl) : null
      const same = other && !('error' in other) && other.page.status === 200 && other.page.title?.toLowerCase() === p.title.toLowerCase()
      return same ? { text: `Titel auf ${path} gleich wie auf ${pathOf(otherUrl!)}`, done: false } : { text: `Titel auf ${path} eindeutig`, done: true }
    }
    case 'desc_missing': return p.description ? { text: `Beschreibung auf ${path} vorhanden (${p.description.length} Zeichen)`, done: true } : { text: `Beschreibung auf ${path} fehlt`, done: false }
    case 'desc_long':
      if (!p.description) return { text: `Beschreibung auf ${path} fehlt`, done: false }
      return p.description.length > DESC_MAX ? { text: `Beschreibung auf ${path} hat ${p.description.length} Zeichen (gut sind bis ${DESC_MAX})`, done: false } : { text: `Beschreibung auf ${path} hat ${p.description.length} Zeichen`, done: true }
    case 'h1_missing': return p.h1Count ? { text: `H1 auf ${path} vorhanden`, done: true } : { text: `H1 auf ${path} fehlt`, done: false }
    case 'hreflang_missing': return p.hreflang ? { text: `Sprachverweise auf ${path}: ${p.hreflang}`, done: true } : { text: `Keine Sprachverweise (hreflang) auf ${path}`, done: false }
    case 'h1_multiple': return p.h1Count > 1 ? { text: `${p.h1Count} H1 auf ${path}`, done: false } : { text: `H1 auf ${path}: ${p.h1Count}`, done: p.h1Count === 1 }
    case 'img_alt': return p.imgNoAlt ? { text: `${p.imgNoAlt} Bilder ohne alt auf ${path}`, done: false } : { text: `Alle Bilder auf ${path} mit alt`, done: true }
    case 'thin': return p.words < THIN_WORDS ? { text: `${path} hat ${p.words} Wörter (gut sind ab ${THIN_WORDS})`, done: false } : { text: `${path} hat ${p.words} Wörter`, done: true }
    case 'canonical_missing': return p.canonical ? { text: `Canonical auf ${path} gesetzt`, done: true } : { text: `Kein Canonical auf ${path}`, done: false }
    case 'canonical_other': return p.canonical && keyOf(p.canonical) !== keyOf(p.url) ? { text: `Canonical auf ${path} zeigt auf ${pathOf(p.canonical)}`, done: false } : { text: `Canonical auf ${path} zeigt auf sich selbst`, done: true }
    default: return { text: `${path}: nicht prüfbar`, done: false }
  }
}

async function checkSeo(db: DbOrTx, task: TaskRow, f: FetchLike): Promise<CheckResult> {
  const group = seoGroupOf(task.origin)!
  const audit = task.projectId ? await latestAudit(db as Db, task.projectId) : null
  const lines = seoLines(task.description, group, audit, task.targetUrl, task.origin?.startsWith('seo:') ? task.origin.split(':')[1] : null)
  if (!lines.length) return { kind: 'seo', ok: false, items: [{ text: 'Keine Seite zum Prüfen gefunden', done: false }] }
  const load = pageLoader(f)
  const items = await inBatches(lines, 4, l => checkSeoLine(l, load))
  return { kind: 'seo', ok: items.every(i => i.done), items: openFirst(items) }
}

function dm(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`
}

async function checkDrop(db: DbOrTx, task: TaskRow, project: Project | null, f: FetchLike): Promise<CheckResult> {
  const path = task.origin!.slice(9)
  const url = task.targetUrl && isHttpUrl(task.targetUrl) ? task.targetUrl : project?.url ? absolute(path, project.url) : null
  if (!url) return { kind: 'seo-drop', ok: false, items: [{ text: 'Keine Seite zum Prüfen gefunden', done: false }] }
  const got = await pageLoader(f)(url)
  if ('error' in got || got.page.status !== 200) return { kind: 'seo-drop', ok: false, items: [{ text: unreachable(pathOf(url), got), done: false }] }
  const since = task.createdAt
  const modified = got.lastModified ? new Date(got.lastModified) : null
  const audit = task.projectId ? await latestAudit(db as Db, task.projectId) : null
  const before = audit && new Date(audit.checkedAt) <= since ? audit.pages.find(p => keyOf(p.url) === keyOf(url)) : undefined
  const p = got.page
  const changed = (modified && !Number.isNaN(modified.getTime()) && modified > since)
    || (before && (before.title !== p.title || before.description !== p.description || before.h1 !== p.h1 || Math.abs(before.words - p.words) >= 20))
  return changed
    ? { kind: 'seo-drop', ok: true, items: [{ text: `${pathOf(url)} seit ${dm(since)} überarbeitet`, done: true }] }
    : { kind: 'seo-drop', ok: false, items: [{ text: `Keine Änderung an ${pathOf(url)} seit ${dm(since)} erkennbar`, done: false }] }
}

// Verzeichnis-Einträge und selbst gepostete Beiträge

function hostOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, '').toLowerCase() : null
  }
  catch {
    return null
  }
}

function plainText(html: string): string {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
}

export function mentions(html: string, project: Pick<Project, 'name' | 'url'>): 'domain' | 'name' | null {
  const host = hostOf(project.url)
  if (host && html.toLowerCase().includes(host)) return 'domain'
  const name = project.name.trim()
  if (name.length >= 4 && new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(plainText(html))) return 'name'
  return null
}

async function latestDraft(db: DbOrTx, taskId: string) {
  const rows = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, taskId)).orderBy(desc(schema.drafts.version)).limit(5)
  return rows.find(d => d.status === 'freigegeben') ?? rows[0] ?? null
}

function candidates(...urls: (string | null | undefined)[]): string[] {
  return [...new Set(urls.filter((u): u is string => !!u && isHttpUrl(u)))]
}

async function checkDirectory(db: DbOrTx, task: TaskRow, project: Project | null, opts: CheckOptions, f: FetchLike): Promise<CheckResult> {
  const own = hostOf(project?.url)
  const draft = await latestDraft(db, task.id)
  const list = candidates(opts.link, task.postedUrl, task.targetUrl, draft?.targetUrl).filter(u => hostOf(u) !== own).slice(0, 3)
  if (!project || !list.length) return { kind: 'directory', ok: false, needLink: true, items: [{ text: 'Link zum Eintrag fehlt', done: false }] }
  const items: CheckItem[] = []
  for (const url of list) {
    const host = hostOf(url)
    try {
      const r = await fetchTimed(url, f, 'GET', 12_000)
      if (r.status >= 400) {
        items.push({ text: `${host} nicht erreichbar (Fehler ${r.status})`, done: false })
        continue
      }
      const hit = mentions(r.html, project)
      if (hit) return { kind: 'directory', ok: true, postedUrl: r.url || url, items: [{ text: `Eintrag auf ${host} gefunden (${hit === 'domain' ? own : project.name})`, done: true }] }
      items.push({ text: `Auf ${host} kein Eintrag für ${project.name} gefunden`, done: false })
    }
    catch (err) {
      items.push({ text: `${host} nicht erreichbar (${(err as Error).message.slice(0, 60)})`, done: false })
    }
  }
  return { kind: 'directory', ok: false, needLink: !opts.link, items }
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(w => w.length >= 4)
}

export function sameText(draft: string, text: string): boolean {
  const want = [...new Set(words(draft))].slice(0, 30)
  if (want.length < 3) return false
  const have = new Set(words(text))
  return want.filter(w => have.has(w)).length / want.length >= 0.7
}

const REDDIT = /^https:\/\/(?:www\.|old\.|new\.|np\.)?reddit\.com(\/[^?#]*)/i

interface RedditItem { text: string, url: string, removed: boolean }

function redditItems(d: unknown): RedditItem[] {
  const out: RedditItem[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk)
    const n = node as { kind?: string, data?: Record<string, unknown> } | null
    if (!n?.data) return
    if (Array.isArray(n.data.children)) return walk(n.data.children)
    const x = n.data
    const text = n.kind === 't3' ? `${x.title ?? ''}\n${x.selftext ?? ''}` : String(x.body ?? '')
    if (typeof x.permalink === 'string') out.push({ text, url: `https://www.reddit.com${x.permalink}`, removed: /^\[(removed|deleted)\]$/.test(String(x.body ?? x.selftext ?? '').trim()) || !!x.removed_by_category })
    const replies = x.replies as { data?: unknown } | undefined
    if (replies && typeof replies === 'object') walk(replies)
  }
  walk(d)
  return out
}

async function redditJson(ws: Workspace, path: string, f: FetchLike): Promise<unknown | null> {
  const app = redditApp(ws)
  try {
    if (app) return await new RedditClient(app, f).get(path.replace(/\/$/, ''), { limit: '500' })
    const res = await f(`https://www.reddit.com${path.replace(/\/$/, '')}.json?raw_json=1&limit=500`, { method: 'GET', headers: { 'User-Agent': userAgent(null) }, signal: AbortSignal.timeout(15_000) })
    return res.ok ? await res.json() : null
  }
  catch {
    return null
  }
}

async function reachable(ws: Workspace, url: string, body: string | null, f: FetchLike): Promise<CheckItem> {
  const host = hostOf(url)
  const reddit = REDDIT.exec(url)
  if (reddit) {
    const d = await redditJson(ws, reddit[1]!, f)
    if (!d) return { text: `Beitrag auf Reddit nicht erreichbar`, done: false }
    const list = redditItems(d)
    const mine = list.find(i => keyOf(i.url) === keyOf(url)) ?? list[0]
    if (mine?.removed) return { text: 'Beitrag auf Reddit entfernt oder gelöscht', done: false }
    return { text: 'Beitrag auf Reddit online', done: true }
  }
  try {
    const r = await fetchTimed(url, f, 'GET', 12_000)
    if (r.status >= 400) return { text: `Beitrag auf ${host} nicht erreichbar (Fehler ${r.status})`, done: false }
    if (body && !sameText(body, plainText(r.html))) return { text: `Beitrag auf ${host} erreichbar, Text nicht gefunden`, done: false }
    return { text: `Beitrag auf ${host} online`, done: true }
  }
  catch (err) {
    return { text: `Beitrag auf ${host} nicht erreichbar (${(err as Error).message.slice(0, 60)})`, done: false }
  }
}

async function checkPost(db: DbOrTx, ws: Workspace, task: TaskRow, opts: CheckOptions, f: FetchLike): Promise<CheckResult> {
  const draft = await latestDraft(db, task.id)
  const body = draft?.body ?? null
  const link = candidates(opts.link, task.postedUrl)[0]
  if (link) {
    const item = await reachable(ws, link, opts.link && !REDDIT.test(link) ? body : null, f)
    return { kind: 'post', ok: item.done, items: [item], postedUrl: item.done ? link : null, needLink: !item.done }
  }
  if (!body) return { kind: 'post', ok: false, needLink: true, items: [{ text: 'Noch kein Text und kein Link zum Beitrag', done: false }] }
  const thread = candidates(draft?.targetUrl, task.targetUrl).find(u => /\/comments\//.test(u) && REDDIT.test(u))
  const subs = subredditsOf(task)
  const places: string[] = thread ? [REDDIT.exec(thread)![1]!] : subs.map(s => `/r/${s}/new`)
  for (const path of places) {
    const d = await redditJson(ws, path, f)
    const hit = d ? redditItems(d).find(i => !i.removed && sameText(body, i.text)) : null
    if (hit) return { kind: 'post', ok: true, postedUrl: hit.url, items: [{ text: `Beitrag auf Reddit gefunden`, done: true }] }
  }
  const key = opts.search ? braveKey(ws) : null
  if (key) {
    try {
      const q = `"${words(body).slice(0, 8).join(' ')}"`
      const found = await braveSearch(key, siteQuery(platformSite(task, thread), q), f, { count: 5, freshness: null, use: { ws: ws.id, project: task.projectId, purpose: 'task-check' } })
      const hit = found.find(r => sameText(body, `${r.title} ${r.snippet}`))
      if (hit) return { kind: 'post', ok: true, postedUrl: hit.url, items: [{ text: `Beitrag gefunden: ${hostOf(hit.url)}`, done: true }] }
    }
    catch {}
  }
  return { kind: 'post', ok: false, needLink: true, items: [{ text: places.length ? 'Beitrag auf Reddit nicht gefunden' : 'Link zum Beitrag fehlt', done: false }] }
}

function platformSite(task: TaskRow, thread: string | undefined): string {
  if (thread || /reddit|(^|\s)r\//i.test(`${task.channel ?? ''} ${task.title}`)) return 'reddit.com'
  return hostOf(task.targetUrl) ?? 'reddit.com'
}

export async function checkTask(db: DbOrTx, ws: Workspace, task: TaskRow, opts: CheckOptions = {}): Promise<CheckResult> {
  const kind = checkKind(task)
  if (!kind) return { kind: null, ok: false, items: [] }
  const f = opts.fetchImpl ?? fetch
  const project = task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  switch (kind) {
    case 'seo': return checkSeo(db, task, f)
    case 'seo-drop': return checkDrop(db, task, project, f)
    case 'directory': return checkDirectory(db, task, project, opts, f)
    case 'post': return checkPost(db, ws, task, opts, f)
  }
}

export type CheckActor = { type: 'user' | 'agent' | 'system' | 'mcp', userId?: string | null }

// Prüfen und bei Erfolg abhaken. auto: täglicher Lauf im Worker.
export async function checkAndClose(db: DbOrTx, ws: Workspace, task: TaskRow, actor: CheckActor, opts: CheckOptions = {}): Promise<CheckResult & { closed: boolean }> {
  const r = await checkTask(db, ws, task, opts)
  if (!r.ok || !OPEN_STATUSES.includes(task.status)) return { ...r, closed: false }
  const patch: Parameters<typeof updateTask>[2] = { status: 'erledigt' }
  if (r.postedUrl && r.postedUrl !== task.postedUrl) patch.postedUrl = r.postedUrl
  await updateTask(db, task, patch, { type: actor.type, userId: actor.userId ?? null })
  await logActivity(db, { workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, actor: actor.type, userId: actor.userId ?? null, action: opts.auto ? 'task_checked_auto' : 'task_checked', detail: { title: task.title, items: r.items.map(i => i.text).slice(0, 10) } })
  return { ...r, closed: true }
}

export const AUTO_CHECK_MAX = 25

// Täglich vor der Planung: offene prüfbare Aufgaben nachsehen und schon Erledigtes abhaken.
export async function checkOpenTasks(db: DbOrTx, ws: Workspace, opts: { fetchImpl?: FetchLike, max?: number } = {}): Promise<{ checked: number, closed: string[] }> {
  const d = today(ws.timezone)
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    inArray(schema.tasks.status, OPEN_STATUSES),
    or(like(schema.tasks.origin, 'seo%'), inArray(schema.tasks.category, ['verzeichnis', 'community', 'social'])),
    or(isNull(schema.tasks.dueDate), lte(schema.tasks.dueDate, addDays(d, 14))),
  )).orderBy(sql`${schema.tasks.dueDate} asc nulls last`).limit(200)
  const list: TaskRow[] = []
  for (const t of rows) {
    const kind = checkKind(t)
    if (!kind) continue
    if (kind === 'post' && !t.postedUrl && t.status !== 'freigegeben') continue
    if (kind === 'directory' && !t.postedUrl && !t.targetUrl) continue
    list.push(t)
    if (list.length >= (opts.max ?? AUTO_CHECK_MAX)) break
  }
  const closed: string[] = []
  for (const t of list) {
    try {
      const r = await checkAndClose(db, ws, t, { type: 'agent' }, { fetchImpl: opts.fetchImpl, auto: true })
      if (r.closed) closed.push(t.code)
    }
    catch {}
  }
  return { checked: list.length, closed }
}

export function checkSummary(r: CheckResult): string {
  return openFirst(r.items).map(i => `${i.done ? 'ok' : 'offen'}: ${i.text}`).join('; ')
}


export async function runTaskChecks(db: Db, ws: Workspace, deps: { fetchImpl?: FetchLike } = {}): Promise<RunOutcome> {
  if (ws.demo) return { status: 'skipped', summary: 'Demo-Arbeitsbereich' }
  return withRun(db, ws, 'task_check', {}, async () => {
    const r = await checkOpenTasks(db, ws, deps)
    if (!r.checked) return { status: 'skipped', summary: 'Keine prüfbaren Aufgaben' }
    return { status: 'ok', summary: `${plural(r.checked, 'Aufgabe', 'Aufgaben')} geprüft${r.closed.length ? `, schon erledigt: ${r.closed.join(', ')}` : ''}`.slice(0, 500) }
  })
}
