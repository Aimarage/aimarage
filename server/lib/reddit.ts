import type { WorkspaceSettings } from '../db/schema'
import { redditSearchUrl, threadNote } from '../../shared/utils/reddit'
import { openApp } from './connections'
import type { FetchLike } from './outlets'
import { errText, jsonOf, PlatformError, timeoutSignal, wait } from './platforms/types'
import { braveKey, braveSearch, redditQuery, redditThreadOf, redditThreads, type BravePurpose, type BraveResult, type BraveUse } from './platforms/brave'

const AUTH = 'https://www.reddit.com/api/v1/access_token'
const API = 'https://oauth.reddit.com'
const WEEK = 7 * 86_400_000
const UNITS: Record<string, number> = { min: 60_000, minute: 60_000, std: 3_600_000, stunde: 3_600_000, hour: 3_600_000, tag: 86_400_000, day: 86_400_000, woche: WEEK, week: WEEK, monat: 30 * 86_400_000, month: 30 * 86_400_000, jahr: 365 * 86_400_000, year: 365 * 86_400_000 }

type Json = Record<string, unknown>
type Workspace = { id: string, settings: WorkspaceSettings | null }

export interface RedditApp {
  clientId: string
  clientSecret: string
  user: string | null
}

export interface RedditComment {
  author: string
  score: number
  body: string
}

export interface RedditThread {
  id: string
  sub: string
  title: string
  url: string
  author: string
  createdAt: string
  comments: number
  score: number
  locked: boolean
  archived: boolean
  text: string
  nsfw?: boolean
  top?: RedditComment[]
  via?: 'brave'
  age?: string | null
  problem?: string
}

// Zeitpunkt eines Threads: Erstellzeit, sonst Datum oder relative Angabe der Suche ("3 days ago", "vor 2 Tagen"). Ohne Datum null.
export function threadTime(t: { createdAt?: string | null, publishedAt?: string | null, age?: string | null }, now = Date.now()): number | null {
  for (const v of [t.createdAt, t.publishedAt]) {
    const at = v ? Date.parse(v) : Number.NaN
    if (!Number.isNaN(at) && at > 0) return at
  }
  const age = t.age?.trim() ?? ''
  if (!age) return null
  const rel = /(\d+)\s*(min|minute|std|stunde|hour|tag|day|woche|week|monat|month|jahr|year)/i.exec(age)
  if (rel && /ago|vor/i.test(age)) return now - Number(rel[1]) * UNITS[rel[2]!.toLowerCase()]!
  if (/^(today|heute)\b/i.test(age) || /^(just now|gerade)/i.test(age)) return now
  if (/^(yesterday|gestern)\b/i.test(age)) return now - 86_400_000
  const at = Date.parse(age)
  return Number.isNaN(at) ? null : at
}

// Höchstens 7 Tage alt, Threads ohne Datum fallen weg.
export function threadFresh(t: { createdAt?: string | null, publishedAt?: string | null, age?: string | null }, now = Date.now()): boolean {
  const at = threadTime(t, now)
  return at !== null && now - at <= WEEK && at - now <= 86_400_000
}

export type RedditLookup =
  | { status: 'found', subs: string[], query: string, searchUrl: string, threads: RedditThread[], rules: Record<string, string[]> }
  | { status: 'no_access' | 'empty' | 'error', subs: string[], query: string, searchUrl: string | null, error?: string }

export function redditApp(ws: Workspace): RedditApp | null {
  const a = openApp(ws, 'reddit', '')
  return a ? { clientId: a.clientId, clientSecret: a.clientSecret, user: ws.settings?.apps?.reddit?.user ?? null } : null
}

export function threadSearch(ws: Workspace): boolean {
  return !!(redditApp(ws) || braveKey(ws))
}

export function userAgent(user: string | null | undefined): string {
  return `aimarage/1.0 by ${user?.replace(/^\/?u\//, '') || 'aimarage'}`
}

const tokens = new Map<string, { token: string, until: number }>()
const rate = { remaining: 100, resetAt: 0 }

export function resetRedditState(): void {
  tokens.clear()
  rate.remaining = 100
  rate.resetAt = 0
}

export class RedditClient {
  constructor(private app: RedditApp, private f: FetchLike, private sleep?: (ms: number) => Promise<void>) {}

  private async token(): Promise<string> {
    const hit = tokens.get(this.app.clientId)
    if (hit && hit.until > Date.now()) return hit.token
    let res: Response
    try {
      res = await this.f(AUTH, { method: 'POST', headers: { 'Authorization': `Basic ${Buffer.from(`${this.app.clientId}:${this.app.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent(this.app.user) }, body: new URLSearchParams({ grant_type: 'client_credentials' }), signal: timeoutSignal(20_000) })
    }
    catch (err) {
      throw new PlatformError(`Reddit: nicht erreichbar (${(err as Error).message.slice(0, 120)})`)
    }
    const d = await jsonOf(res)
    if (!res.ok || typeof d.access_token !== 'string') throw new PlatformError(res.status === 401 ? 'Reddit: Client-ID oder Secret abgelehnt (401)' : `Reddit: ${errText(d, res.status)}`, res.status)
    tokens.set(this.app.clientId, { token: d.access_token, until: Date.now() + (Number(d.expires_in ?? 3600) - 60) * 1000 })
    return d.access_token
  }

  async get(path: string, params: Record<string, string> = {}, retry = true): Promise<unknown> {
    if (rate.remaining < 2 && rate.resetAt > Date.now()) {
      const ms = rate.resetAt - Date.now()
      if (ms > 60_000) throw new PlatformError('Reddit: Anfrage-Limit erreicht, später erneut versuchen', 429)
      await wait({ sleep: this.sleep }, ms)
    }
    const url = `${API}${path}?${new URLSearchParams({ ...params, raw_json: '1' })}`
    let res: Response
    try {
      res = await this.f(url, { method: 'GET', headers: { 'Authorization': `Bearer ${await this.token()}`, 'User-Agent': userAgent(this.app.user) }, signal: timeoutSignal(20_000) })
    }
    catch (err) {
      if (err instanceof PlatformError) throw err
      throw new PlatformError(`Reddit: nicht erreichbar (${(err as Error).message.slice(0, 120)})`)
    }
    const remaining = Number(res.headers.get('x-ratelimit-remaining'))
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    if (Number.isFinite(remaining) && res.headers.has('x-ratelimit-remaining')) rate.remaining = remaining
    if (Number.isFinite(reset) && res.headers.has('x-ratelimit-reset')) rate.resetAt = Date.now() + reset * 1000
    if (res.status === 401 && retry) {
      tokens.delete(this.app.clientId)
      return this.get(path, params, false)
    }
    const text = await res.text().catch(() => '')
    if (res.status === 429) throw new PlatformError('Reddit: Anfrage-Limit erreicht, später erneut versuchen', 429)
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    }
    catch {
      data = null
    }
    if (!res.ok) throw new PlatformError(`Reddit: ${errText((data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Json, res.status)}`, res.status)
    return data
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

export function parseListing(d: unknown): RedditThread[] {
  const children = ((d as Json | null)?.data as Json | undefined)?.children
  if (!Array.isArray(children)) return []
  return children.map(c => (c as Json).data as Json).filter(p => p && str(p.id) && str(p.permalink) && !p.stickied).map(p => ({
    id: str(p.id),
    sub: str(p.subreddit),
    title: str(p.title),
    url: `https://www.reddit.com${str(p.permalink)}`,
    author: str(p.author),
    createdAt: new Date(Number(p.created_utc ?? 0) * 1000).toISOString(),
    comments: Number(p.num_comments ?? 0),
    score: Number(p.score ?? 0),
    locked: !!p.locked,
    archived: !!p.archived,
    text: str(p.selftext),
    ...(p.over_18 ? { nsfw: true } : {}),
  }))
}

export function parseComments(d: unknown, max = 5): RedditComment[] {
  const list = Array.isArray(d) ? d[1] : null
  const children = ((list as Json | null)?.data as Json | undefined)?.children
  if (!Array.isArray(children)) return []
  return children.filter(c => (c as Json).kind === 't1').map(c => (c as Json).data as Json)
    .filter(c => !c.stickied && str(c.body) && !['[deleted]', '[removed]'].includes(str(c.body)))
    .slice(0, max).map(c => ({ author: str(c.author), score: Number(c.score ?? 0), body: oneLine(str(c.body), 400) }))
}

const STOP = new Set(['antwort', 'reply', 'recherche', 'research', 'reddit', 'thread', 'threads', 'beitrag', 'post', 'posts', 'top', 'vs', 'versus', 'und', 'oder', 'der', 'die', 'das', 'für', 'mit', 'auf', 'zum', 'zur', 'ein', 'eine', 'the', 'and', 'for', 'with', 'about', 'what', 'how', 'why', 'von', 'zu', 'im', 'in', 'an', 'is', 'are', 'it'])

export function keywords(title: string): string[] {
  const clean = title.replace(/^[^:]{0,30}:\s*/, '').replace(/(^|\s)\/?r\/\w+/g, ' ')
  const words = clean.split(/[^\p{L}\p{N}+#.-]+/u).map(w => w.replace(/^[.-]+|[.-]+$/g, '')).filter(w => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w.toLowerCase()))
  return [...new Set(words)].slice(0, 5)
}

export function subredditsOf(task: { title: string, description?: string | null, channel?: string | null, targetUrl?: string | null }, communities: string[] = []): string[] {
  const grab = (s: string) => [...s.matchAll(/(?:^|[\s/(,;])r\/([A-Za-z0-9_]{2,21})\b/g)].map(m => m[1]!)
  const own = grab([task.channel, task.targetUrl, task.title, task.description].filter(Boolean).join(' '))
  const list = own.length ? own : grab(communities.join(' '))
  const seen = new Set<string>()
  return list.filter((s) => {
    const k = s.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, 3)
}

function matches(t: RedditThread, words: string[]): number {
  const hay = `${t.title} ${t.text}`.toLowerCase()
  return words.filter(w => hay.includes(w.toLowerCase())).length
}

export function rankThreads(list: RedditThread[], words: string[], now: number, max = 3): RedditThread[] {
  const byId = new Map<string, RedditThread>()
  for (const t of list) if (!byId.has(t.id)) byId.set(t.id, t)
  return [...byId.values()]
    .filter(t => !t.locked && !t.archived && !t.nsfw && now - Date.parse(t.createdAt) <= WEEK && matches(t, words) > 0)
    .map(t => ({ t, rank: matches(t, words) * 10 + Math.log2(t.comments + 1) * 2 - (now - Date.parse(t.createdAt)) / 86_400_000 }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, max)
    .map(x => x.t)
}

export async function findThreads(c: RedditClient, subs: string[], words: string[], now: number, max = 3): Promise<RedditThread[]> {
  const found: RedditThread[] = []
  for (const sub of subs) {
    if (words.length) found.push(...parseListing(await c.get(`/r/${sub}/search`, { q: words.join(' '), restrict_sr: '1', sort: 'new', t: 'week', limit: '25', type: 'link' })))
    found.push(...parseListing(await c.get(`/r/${sub}/new`, { limit: '50' })))
  }
  return rankThreads(found, words, now, max)
}

export async function readThread(c: RedditClient, t: RedditThread, max = 5): Promise<RedditThread> {
  const d = await c.get(`/comments/${t.id}`, { sort: 'top', limit: String(max * 2), depth: '1' })
  const fresh = parseListing(Array.isArray(d) ? d[0] : null)[0]
  return { ...t, ...(fresh ?? {}), top: parseComments(d, max) }
}

const PROMO = /promot|self|spam|advertis|werb|link|market|affiliat|blog/i

export async function subRules(c: RedditClient, sub: string): Promise<string[]> {
  const d = await c.get(`/r/${sub}/about/rules`) as Json | null
  const rules = Array.isArray(d?.rules) ? d.rules as Json[] : []
  const lines = rules.map(r => ({ name: str(r.short_name), text: oneLine(str(r.description), 240) })).filter(r => r.name)
  const promo = lines.filter(r => PROMO.test(`${r.name} ${r.text}`))
  return (promo.length ? promo : lines.slice(0, 4)).map(r => (r.text ? `${r.name}: ${r.text}` : r.name))
}

export function excerpt(t: RedditThread): string {
  return oneLine(t.text || t.top?.[0]?.body || '', 280)
}

type TaskRef = { title: string, description?: string | null, channel?: string | null, targetUrl?: string | null, projectId?: string | null }

async function apiLookup(app: RedditApp, subs: string[], words: string[], base: { query: string, searchUrl: string }, f: FetchLike, log: string[], now: number): Promise<RedditLookup> {
  const c = new RedditClient(app, f)
  try {
    const top = await findThreads(c, subs, words, now)
    if (!top.length) return { status: 'empty', subs, ...base }
    const threads: RedditThread[] = []
    for (const t of top) threads.push(await readThread(c, t))
    const open = threads.filter(t => !t.locked && !t.archived)
    if (!open.length) return { status: 'empty', subs, ...base }
    const rules: Record<string, string[]> = {}
    for (const sub of [...new Set(open.map(t => t.sub))]) rules[sub] = await subRules(c, sub).catch(() => [])
    return { status: 'found', subs, ...base, threads: open, rules }
  }
  catch (err) {
    log.push(`Reddit-Suche fehlgeschlagen: ${(err as Error).message.slice(0, 200)}`)
    return { status: 'error', subs, ...base, error: (err as Error).message.slice(0, 200) }
  }
}

export function braveThread(r: BraveResult): RedditThread {
  const t = redditThreadOf(r.url)!
  return {
    id: t.id,
    sub: t.sub,
    title: r.title.replace(/^r\/\w+ on Reddit:\s*/i, '').replace(/\s*:\s*r\/\w+\s*$/i, '').replace(/\s+-\s+Reddit\s*$/i, '') || r.title,
    url: r.url.replace(/^https:\/\/(?:www\.|old\.|new\.)?reddit\.com/i, 'https://www.reddit.com').replace(/[?#].*$/, ''),
    author: '',
    createdAt: r.publishedAt ?? (threadTime(r) ? new Date(threadTime(r)!).toISOString() : ''),
    comments: 0,
    score: 0,
    locked: false,
    archived: false,
    text: r.snippet,
    via: 'brave',
    age: r.age,
  }
}

export async function braveThreads(key: string, subs: string[], words: string[], f: FetchLike, max = 8, sleep?: (ms: number) => Promise<void>, more: string[] = [], now = Date.now(), use?: BraveUse): Promise<RedditThread[]> {
  const found: BraveResult[] = []
  const own = subs.length ? subs : [null]
  const fresh = (r: BraveResult) => threadFresh(r, now)
  for (const list of [own, more]) {
    for (const sub of list) {
      found.push(...redditThreads(await braveSearch(key, redditQuery(sub, words), f, { sleep, freshness: 'pw', use }), sub).filter(fresh))
      if (found.length >= max) break
    }
    if (found.length) break
  }
  return redditThreads(found).slice(0, max).map(braveThread)
}

export async function redditLookup(ws: Workspace, task: TaskRef, communities: string[], f: FetchLike, log: string[], now = Date.now(), words = keywords(task.title), purpose: BravePurpose = 'reddit'): Promise<RedditLookup | null> {
  const subs = subredditsOf(task, communities)
  const key = braveKey(ws)
  if (!subs.length && !(key && words.length)) return null
  const query = words.join(' ')
  const base = { query, searchUrl: redditSearchUrl(subs[0] ?? null, query || subs[0]!) }
  const app = redditApp(ws)
  if (!app && !key) return { status: 'no_access', subs, ...base }
  if (app && subs.length) {
    const r = await apiLookup(app, subs, words, base, f, log, now)
    if (r.status === 'found' || !key) return r
  }
  try {
    const more = subredditsOf({ title: '' }, communities).filter(c => !subs.some(s => s.toLowerCase() === c.toLowerCase())).slice(0, 2)
    const threads = await braveThreads(key!, subs, words, f, 8, undefined, more, now, { ws: ws.id, project: task.projectId, purpose })
    return threads.length ? { status: 'found', subs, ...base, threads, rules: {} } : { status: 'empty', subs, ...base }
  }
  catch (err) {
    log.push(`Brave-Suche fehlgeschlagen: ${(err as Error).message.slice(0, 200)}`)
    return { status: 'error', subs, ...base, error: (err as Error).message.slice(0, 200) }
  }
}

function age(iso: string, now: number): string {
  if (Number.isNaN(Date.parse(iso))) return 'Alter unbekannt'
  const h = Math.max(1, Math.round((now - Date.parse(iso)) / 3_600_000))
  return h < 48 ? `vor ${h} Std.` : `vor ${Math.round(h / 24)} Tagen`
}

export function redditSource(r: RedditLookup, research: boolean, now = Date.now()): string {
  if (r.status !== 'found') {
    const where = r.subs.length ? `In ${r.subs.map(s => `r/${s}`).join(', ')}` : 'Auf Reddit'
    const why = r.status === 'no_access' ? 'Reddit-Suche nicht eingerichtet (der Mensch trägt unter Einstellungen > Plattform-Zugänge einen Brave-Search-API-Schlüssel ein)' : `${where} gab es zuletzt keinen passenden offenen Thread`
    return research
      ? `${why}. Such-Link: ${r.searchUrl}. Nenne diesen Such-Link als Fundstelle, erfinde keine Threads und frage den Menschen NICHT nach Threads oder Links.`
      : `${why}. Schreibe deshalb eine allgemeine Antwortvorlage zum Thema, die in einen typischen Thread dazu passt (kein Bezug auf einen bestimmten Beitrag, keine erfundenen Zitate). "targetUrl" leer lassen. Frage den Menschen NICHT nach Threads oder Links; er sucht mit diesem Link selbst: ${r.searchUrl}`
  }
  const brave = r.threads.some(t => t.via === 'brave')
  const lines = [
    brave ? 'Aktuelle Reddit-Threads (letzte 7 Tage, über die Brave-Suche gefunden; nur Titel und Auszug bekannt):' : `Aktive Reddit-Threads (letzte 7 Tage, offen, über die Reddit-API gelesen):`,
    ...r.threads.map((t, i) => [
      `\n${i + 1}. r/${t.sub}: "${t.title}"`,
      `Link: ${t.url}`,
      t.via === 'brave' ? (t.age || age(t.createdAt, now)) : `${age(t.createdAt, now)}, ${t.comments} Kommentare, ${t.score} Punkte`,
      t.text ? `${t.via === 'brave' ? 'Auszug' : 'Text'}: ${oneLine(t.text, 1200)}` : '',
      t.problem ? `Problem der Person (laut Relevanz-Check): ${t.problem}` : '',
      t.top?.length ? `Top-Kommentare:\n${t.top.map(c => `- (${c.score}) ${c.body}`).join('\n')}` : '',
    ].filter(Boolean).join('\n')),
    ...Object.entries(r.rules).filter(([, v]) => v.length).map(([sub, v]) => `\nRegeln von r/${sub} (vor allem zu Eigenwerbung, strikt beachten):\n${v.map(x => `- ${x}`).join('\n')}`),
  ]
  if (research) lines.push('\nNutze genau diese Threads als Fundstellen (mit Link). Keine weiteren Threads erfinden.')
  else lines.push(`\nWähle den Thread, in dem eine hilfreiche Antwort am meisten bringt und Eigenwerbung erlaubt bzw. am wenigsten heikel ist. Schreibe die Antwort genau auf diesen Thread (gehe auf Frage und Kommentare ein), in der Sprache des Threads, und setze "targetUrl" exakt auf seinen Link. ${NO_HELP_SKIP} In "notes" kurz, welches Problem die Person hat und wie die Antwort es löst.${brave ? ' Du kennst nur Titel und Auszug: gehe genau darauf ein und erfinde keine weiteren Details aus dem Thread oder den Kommentaren.' : ''}`)
  return lines.join('\n')
}

export const NO_HELP_SKIP = 'Antworte nur, wenn unser Produkt oder unser Fachwissen das konkrete Problem der fragenden Person wirklich löst. Löst es das nicht, wäre die Antwort nur Präsenz oder ein Allgemeinplatz, oder verbieten die Regeln genau die Hilfe, die wir geben könnten: dann nicht antworten, sondern "skip" mit einem kurzen Grund setzen.'

export function pickThread(r: RedditLookup, targetUrl: string | null | undefined): RedditThread | null {
  if (r.status !== 'found') return null
  const norm = (u: string) => u.replace(/^https?:\/\/(www\.|old\.)?reddit\.com/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  const want = targetUrl ? norm(targetUrl) : ''
  return r.threads.find(t => want && norm(t.url) === want) ?? r.threads[0]!
}

export function redditThreadNote(t: RedditThread, now = Date.now()): string {
  return threadNote({ title: t.title, url: t.url, excerpt: excerpt(t), age: t.createdAt && !Number.isNaN(Date.parse(t.createdAt)) ? age(t.createdAt, now) : null })
}
