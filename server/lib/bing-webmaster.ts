import { and, eq } from 'drizzle-orm'
import type { ProjectBing } from '../db/schema'
import { now, today } from './clock'
import { openAppKey } from './connections'
import type { Db } from './db'
import { schema } from './db'
import { redactKey } from './llm'
import { SearchError, searchRange, storeSearch, type SearchRow } from './search-console'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const API = 'https://ssl.bing.com/webmaster/api.svc/json'

export function bingKey(ws: Workspace): string | null {
  return openAppKey(ws, 'bing')
}

async function bingCall(f: FetchLike, key: string, method: string, params: Record<string, string> = {}): Promise<unknown[]> {
  const u = new URL(`${API}/${method}`)
  u.searchParams.set('apikey', key)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  let res: Response
  try {
    res = await f(u.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  }
  catch (err) {
    throw new SearchError(redactKey(`Bing nicht erreichbar (${(err as Error).message})`, key).slice(0, 300))
  }
  const text = await res.text().catch(() => '')
  let data: Record<string, unknown> = {}
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {}
  }
  catch {}
  const detail = String(data.Message ?? data.message ?? '').slice(0, 120)
  if (!res.ok || data.ErrorCode !== undefined) {
    const denied = res.status === 401 || res.status === 403 || /invalidapikey|notauthorized|apikey/i.test(detail)
    const msg = denied
      ? 'Bing-API-Schlüssel abgelehnt, bitte unter Einstellungen > Plattform-Zugänge > Bing neu eintragen'
      : /notfound|siteunverified|unverified/i.test(detail) ? `Website in Bing nicht gefunden oder nicht bestätigt${detail ? ` (${detail})` : ''}` : `Bing antwortet mit Fehler ${res.status}${detail ? `: ${detail}` : ''}`
    throw new SearchError(redactKey(msg, key).slice(0, 300))
  }
  return Array.isArray(data.d) ? data.d as unknown[] : []
}

export function bingDay(v: unknown): string | null {
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(String(v ?? ''))
  if (!m) return /^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null
  let ms = Number(m[1])
  if (m[2]) {
    const sign = m[2][0] === '-' ? -1 : 1
    ms += sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3, 5))) * 60_000
  }
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export async function listBingSites(key: string, f: FetchLike = fetch): Promise<string[]> {
  const list = await bingCall(f, key, 'GetUserSites') as Record<string, unknown>[]
  return list.filter(s => typeof s?.Url === 'string' && s.IsVerified !== false).map(s => String(s.Url))
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '')
  }
  catch {
    return null
  }
}

export function pickBingSite(sites: string[], projectUrl: string | null | undefined): string | null {
  const host = hostOf(projectUrl)
  if (!host) return null
  const same = sites.filter(s => hostOf(s) === host)
  return same.find(s => /^https:/i.test(s)) ?? same[0] ?? null
}

const num = (v: unknown) => Math.max(0, Math.round(Number(v) || 0))
const posOf = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
}

export async function queryBing(key: string, site: string, range: { from: string, to: string }, f: FetchLike = fetch): Promise<SearchRow[]> {
  const inRange = (d: string | null): d is string => !!d && d >= range.from && d <= range.to
  const out: SearchRow[] = []
  for (const r of await bingCall(f, key, 'GetRankAndTrafficStats', { siteUrl: site }) as Record<string, unknown>[]) {
    const day = bingDay(r?.Date)
    if (inRange(day)) out.push({ day, query: '', page: '', clicks: num(r.Clicks), impressions: num(r.Impressions), position: 0 })
  }
  for (const r of await bingCall(f, key, 'GetPageStats', { siteUrl: site }) as Record<string, unknown>[]) {
    const day = bingDay(r?.Date)
    const page = String(r?.Query ?? '').slice(0, 500)
    if (inRange(day) && page) out.push({ day, query: '', page, clicks: num(r.Clicks), impressions: num(r.Impressions), position: posOf(r.AvgImpressionPosition) })
  }
  for (const r of await bingCall(f, key, 'GetQueryStats', { siteUrl: site }) as Record<string, unknown>[]) {
    const day = bingDay(r?.Date)
    const query = String(r?.Query ?? '').slice(0, 300)
    if (inRange(day) && query) out.push({ day, query, page: '', clicks: num(r.Clicks), impressions: num(r.Impressions), position: posOf(r.AvgImpressionPosition) })
  }
  return sumRows(out)
}

function sumRows(rows: SearchRow[]): SearchRow[] {
  const m = new Map<string, SearchRow & { wp: number }>()
  for (const r of rows) {
    const k = [r.day, r.query, r.page].join('\u0000')
    const cur = m.get(k)
    if (!cur) m.set(k, { ...r, wp: r.position * r.impressions })
    else {
      cur.clicks += r.clicks
      cur.impressions += r.impressions
      cur.wp += r.position * r.impressions
    }
  }
  return [...m.values()].map(({ wp, ...r }) => ({ ...r, position: r.impressions ? Math.round((wp / r.impressions) * 100) / 100 : r.position }))
}

export async function setBing(db: Db, projectId: string, patch: Partial<ProjectBing> | null): Promise<void> {
  const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, projectId))
  if (!p) return
  const bing = patch === null ? null : { ...p.setup?.bing, ...patch }
  await db.update(schema.projects).set({ setup: { ...p.setup, bing } }).where(eq(schema.projects.id, projectId))
}

export function bingWanted(ws: Workspace, project: Project): boolean {
  const b = project.setup?.bing
  return !!ws.settings?.apps?.bing?.secret && !b?.off && !!(b?.site || project.url)
}

export async function syncProjectBing(db: Db, ws: Workspace, project: Project, f: FetchLike = fetch): Promise<number> {
  const key = bingKey(ws)
  if (!key) throw new SearchError(ws.settings?.apps?.bing?.secret ? 'Bing-API-Schlüssel unlesbar, bitte neu eintragen' : 'Kein Bing-API-Schlüssel eingetragen')
  try {
    let site = project.setup?.bing?.site ?? null
    if (!site) {
      site = pickBingSite(await listBingSites(key, f), project.url)
      if (!site) throw new SearchError('Keine passende Website in Bing gefunden, bitte unter Berichte > Suche > Bing wählen')
      await setBing(db, project.id, { site })
    }
    const range = searchRange(today(ws.timezone))
    const n = await storeSearch(db, project.id, range, await queryBing(key, site, range, f), 'bing')
    await setBing(db, project.id, { lastSync: now().toISOString(), error: null })
    return n
  }
  catch (err) {
    const msg = redactKey(err instanceof SearchError ? err.message : (err as Error).message, key).slice(0, 300)
    await setBing(db, project.id, { error: msg })
    throw new SearchError(msg)
  }
}

export async function setBingSite(db: Db, projectId: string, site: string | null): Promise<void> {
  await setBing(db, projectId, site ? { site, off: false, lastSync: null, error: null } : { site: null, off: true, lastSync: null, error: null })
  await clearBing(db, projectId)
}

async function clearBing(db: Db, projectId: string): Promise<void> {
  await db.delete(schema.searchStats).where(and(eq(schema.searchStats.projectId, projectId), eq(schema.searchStats.source, 'bing')))
}

export function publicBing(ws: Workspace, b: ProjectBing | null | undefined) {
  return { keyReady: !!ws.settings?.apps?.bing?.secret, site: b?.site ?? null, off: !!b?.off, lastSync: b?.lastSync ?? null, error: b?.error ?? null }
}
