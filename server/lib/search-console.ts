import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { addDays } from '../../shared/utils/dates'
import type { ProjectGoogle } from '../db/schema'
import { now, today } from './clock'
import { openApp, updateSettings } from './connections'
import type { Db } from './db'
import { schema } from './db'
import { keyHint, redactKey } from './llm'
import { defaultRedirect, newState } from './platforms/oauth'
import { decryptSecret, encryptSecret } from './secret'
import { bingWanted, syncProjectBing } from './bing-webmaster'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export class SearchError extends Error {}

export const GOOGLE_EXPIRED = 'Verbindung zur Google Search Console abgelaufen oder widerrufen, bitte neu verbinden'

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/webmasters/v3'
export const SEARCH_DAYS = 28
const PAGE_ROWS = 25_000
const MAX_PAGES = 4

function ctxOf(workspaceId: string, projectId: string): string {
  return `google|${workspaceId}|${projectId}`
}

export function googleApp(ws: Workspace, appUrl: string) {
  return openApp(ws, 'google', defaultRedirect(appUrl, 'google'))
}

export function googleAuthorizeUrl(app: { clientId: string, redirectUri: string }, state: string): string {
  const u = new URL(AUTH_URL)
  u.searchParams.set('client_id', app.clientId)
  u.searchParams.set('redirect_uri', app.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', GOOGLE_SCOPE)
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  u.searchParams.set('include_granted_scopes', 'true')
  u.searchParams.set('state', state)
  return u.toString()
}

export async function startGoogle(db: Db, ws: Workspace, projectId: string, appUrl: string): Promise<string> {
  const app = googleApp(ws, appUrl)
  if (!app) throw new SearchError('Google-Zugang fehlt: zuerst unter Einstellungen > Plattform-Zugänge eintragen')
  const state = newState()
  await updateSettings(db, ws.id, s => ({ ...s, oauthStates: [...(s.oauthStates ?? []).filter(x => Date.now() - Date.parse(x.at) < 3_600_000).slice(-9), { state, provider: 'google', projectId, at: new Date().toISOString() }] }))
  return googleAuthorizeUrl(app, state)
}

async function googleJson(f: FetchLike, url: string, init: RequestInit, secrets: string[] = []): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(30_000) })
  }
  catch (err) {
    let msg = `Google nicht erreichbar (${(err as Error).message})`
    for (const s of secrets) msg = redactKey(msg, s)
    throw new SearchError(msg.slice(0, 300))
  }
  const text = await res.text().catch(() => '')
  let data: Record<string, unknown> = {}
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {}
  }
  catch {}
  if (!res.ok) {
    const e = data.error
    const detail = typeof e === 'object' && e ? String((e as Record<string, unknown>).message ?? '') : String(data.error_description ?? e ?? '')
    let msg = res.status === 401 || data.error === 'invalid_grant'
      ? GOOGLE_EXPIRED
      : res.status === 403 ? `Kein Zugriff (403)${detail ? `: ${detail}` : ''}. Ist die "Google Search Console API" im Google-Cloud-Projekt aktiviert?` : `Google antwortet mit Fehler ${res.status}${detail ? `: ${detail}` : ''}`
    for (const s of secrets) msg = redactKey(msg, s)
    throw new SearchError(msg.slice(0, 300))
  }
  return data
}

export async function exchangeGoogleCode(app: { clientId: string, clientSecret: string, redirectUri: string }, code: string, f: FetchLike = fetch): Promise<{ refreshToken: string, accessToken: string }> {
  const data = await googleJson(f, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri, grant_type: 'authorization_code' }) }, [app.clientSecret, code])
  if (typeof data.refresh_token !== 'string' || typeof data.access_token !== 'string') throw new SearchError('Google hat keinen dauerhaften Zugang geliefert, bitte erneut verbinden')
  if (typeof data.scope === 'string' && !data.scope.includes('webmasters')) throw new SearchError('Zugriff auf die Search Console wurde nicht erlaubt')
  return { refreshToken: data.refresh_token, accessToken: data.access_token }
}

export function sealGoogle(workspaceId: string, projectId: string, refreshToken: string, at = new Date()): NonNullable<ProjectGoogle['secret']> {
  return { enc: encryptSecret(refreshToken, ctxOf(workspaceId, projectId)), hint: keyHint(refreshToken), setAt: at.toISOString() }
}

export function googleRefreshToken(workspaceId: string, projectId: string, g: ProjectGoogle | null | undefined): string | null {
  return g?.secret ? decryptSecret(g.secret.enc, ctxOf(workspaceId, projectId)) : null
}

export async function googleAccessToken(ws: Workspace, project: Project, appUrl: string, f: FetchLike = fetch): Promise<string> {
  const app = googleApp(ws, appUrl)
  if (!app) throw new SearchError('Google-Zugang fehlt (Einstellungen > Plattform-Zugänge)')
  const refresh = googleRefreshToken(ws.id, project.id, project.setup?.google)
  if (!refresh) throw new SearchError(project.setup?.google?.secret ? 'Google-Zugang unlesbar, bitte neu verbinden' : 'Nicht mit Google verbunden')
  const data = await googleJson(f, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ refresh_token: refresh, client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token' }) }, [app.clientSecret, refresh])
  if (typeof data.access_token !== 'string') throw new SearchError('Google hat keinen Zugang geliefert')
  return data.access_token
}

export interface GoogleSite {
  siteUrl: string
  permissionLevel: string
}

export async function listSites(accessToken: string, f: FetchLike = fetch): Promise<GoogleSite[]> {
  const data = await googleJson(f, `${API}/sites`, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }, [accessToken])
  const list = Array.isArray(data.siteEntry) ? data.siteEntry as Record<string, unknown>[] : []
  return list.filter(s => typeof s.siteUrl === 'string' && s.permissionLevel !== 'siteUnverifiedUser').map(s => ({ siteUrl: String(s.siteUrl), permissionLevel: String(s.permissionLevel ?? '') }))
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

export function pickProperty(sites: GoogleSite[], projectUrl: string | null | undefined): string | null {
  const host = hostOf(projectUrl)
  if (!host) return sites.length === 1 ? sites[0]!.siteUrl : null
  const domain = sites.find(s => s.siteUrl.startsWith('sc-domain:') && (host === s.siteUrl.slice(10).toLowerCase() || host.endsWith(`.${s.siteUrl.slice(10).toLowerCase()}`)))
  if (domain) return domain.siteUrl
  const prefix = sites.find(s => !s.siteUrl.startsWith('sc-domain:') && hostOf(s.siteUrl) === host && (new URL(s.siteUrl).pathname === '/'))
  return prefix?.siteUrl ?? sites.find(s => hostOf(s.siteUrl.replace(/^sc-domain:/, '')) === host)?.siteUrl ?? null
}

async function setGoogle(db: Db, projectId: string, patch: Partial<ProjectGoogle> | null): Promise<void> {
  const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, projectId))
  if (!p) return
  const google = patch === null ? null : { ...p.setup?.google, ...patch }
  await db.update(schema.projects).set({ setup: { ...p.setup, google } }).where(eq(schema.projects.id, projectId))
}

export async function finishGoogle(db: Db, ws: Workspace, code: string, state: string | null, appUrl: string, f: FetchLike = fetch): Promise<{ projectId: string, property: string | null }> {
  const match = (ws.settings?.oauthStates ?? []).find(x => x.state === state && x.provider === 'google')
  if (!state || !match?.projectId) throw new SearchError('Anmeldung abgelaufen oder aus einem anderen Fenster, bitte "Mit Google verbinden" erneut klicken')
  const app = googleApp(ws, appUrl)
  if (!app) throw new SearchError('Google-Zugang fehlt')
  const [project] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, match.projectId), eq(schema.projects.workspaceId, ws.id)))
  if (!project) throw new SearchError('Projekt nicht gefunden')
  const tokens = await exchangeGoogleCode(app, code, f)
  await updateSettings(db, ws.id, s => ({ ...s, oauthStates: (s.oauthStates ?? []).filter(x => x.state !== state) }))
  // Neu verbinden behält Website und bisherige Zahlen, solange das Google-Konto die Website noch sieht.
  const keep = project.setup?.google?.property ?? null
  let sites: GoogleSite[] | null = null
  try {
    sites = await listSites(tokens.accessToken, f)
  }
  catch {}
  const property = keep && (!sites || sites.some(x => x.siteUrl === keep)) ? keep : sites ? pickProperty(sites, project.url) : null
  const same = !!keep && property === keep
  await setGoogle(db, project.id, { secret: sealGoogle(ws.id, project.id, tokens.refreshToken), property, connectedAt: now().toISOString(), lastSync: same ? project.setup?.google?.lastSync ?? null : null, error: null })
  if (keep && !same) await db.delete(schema.searchStats).where(and(eq(schema.searchStats.projectId, project.id), eq(schema.searchStats.source, 'google')))
  return { projectId: project.id, property }
}

export async function setProperty(db: Db, projectId: string, property: string): Promise<void> {
  await setGoogle(db, projectId, { property, lastSync: null, error: null })
  await db.delete(schema.searchStats).where(and(eq(schema.searchStats.projectId, projectId), eq(schema.searchStats.source, 'google')))
}

export async function disconnectGoogle(db: Db, project: Project, f: FetchLike = fetch): Promise<void> {
  const refresh = googleRefreshToken(project.workspaceId, project.id, project.setup?.google)
  if (refresh) await f(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {})
  await setGoogle(db, project.id, null)
  await db.delete(schema.searchStats).where(and(eq(schema.searchStats.projectId, project.id), eq(schema.searchStats.source, 'google')))
}

export function publicGoogle(g: ProjectGoogle | null | undefined) {
  if (!g?.secret) return null
  return { property: g.property ?? null, connectedAt: g.connectedAt ?? null, lastSync: g.lastSync ?? null, error: g.error ?? null }
}

export interface SearchRow {
  day: string
  query: string
  page: string
  clicks: number
  impressions: number
  position: number
}

export async function querySearch(accessToken: string, property: string, range: { from: string, to: string }, dimensions: ('date' | 'query' | 'page')[], f: FetchLike = fetch): Promise<SearchRow[]> {
  const out: SearchRow[] = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const data = await googleJson(f, `${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: range.from, endDate: range.to, dimensions, rowLimit: PAGE_ROWS, startRow: i * PAGE_ROWS, type: 'web' }),
    }, [accessToken])
    const rows = Array.isArray(data.rows) ? data.rows as Record<string, unknown>[] : []
    for (const r of rows) {
      const keys = Array.isArray(r.keys) ? r.keys.map(String) : []
      const k = (d: string) => keys[dimensions.indexOf(d as never)] ?? ''
      const day = k('date')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      out.push({ day, query: k('query').slice(0, 300), page: k('page').slice(0, 500), clicks: Math.max(0, Math.round(Number(r.clicks) || 0)), impressions: Math.max(0, Math.round(Number(r.impressions) || 0)), position: Math.round((Number(r.position) || 0) * 100) / 100 })
    }
    if (rows.length < PAGE_ROWS) break
  }
  return out
}

export function searchRange(d: string): { from: string, to: string } {
  return { from: addDays(d, -SEARCH_DAYS), to: addDays(d, -1) }
}

export type SearchSource = 'google' | 'bing'
export const SEARCH_LABEL: Record<SearchSource, string> = { google: 'Google', bing: 'Bing' }

export async function storeSearch(db: Db, projectId: string, range: { from: string, to: string }, rows: SearchRow[], source: SearchSource = 'google'): Promise<number> {
  const m = new Map<string, SearchRow>()
  for (const r of rows) {
    const key = [r.day, r.query, r.page].join('\u0000')
    if (!m.has(key)) m.set(key, r)
  }
  const list = [...m.values()]
  await db.transaction(async (tx) => {
    await tx.delete(schema.searchStats).where(and(eq(schema.searchStats.projectId, projectId), eq(schema.searchStats.source, source), gte(schema.searchStats.day, range.from), lte(schema.searchStats.day, range.to)))
    for (let i = 0; i < list.length; i += 500) {
      await tx.insert(schema.searchStats).values(list.slice(i, i + 500).map(r => ({ projectId, source, ...r })))
        .onConflictDoUpdate({ target: [schema.searchStats.projectId, schema.searchStats.source, schema.searchStats.day, schema.searchStats.query, schema.searchStats.page], set: { clicks: sql`excluded.clicks`, impressions: sql`excluded.impressions`, position: sql`excluded.position` } })
    }
  })
  return list.length
}

export async function syncProjectSearch(db: Db, ws: Workspace, project: Project, appUrl: string, f: FetchLike = fetch): Promise<number> {
  const g = project.setup?.google
  if (!g?.secret) throw new SearchError('Nicht mit Google verbunden')
  if (!g.property) throw new SearchError('Noch keine Website (Property) gewählt')
  try {
    const token = await googleAccessToken(ws, project, appUrl, f)
    const range = searchRange(today(ws.timezone))
    const rows = [
      ...await querySearch(token, g.property, range, ['date'], f),
      ...await querySearch(token, g.property, range, ['date', 'page'], f),
      ...await querySearch(token, g.property, range, ['date', 'query', 'page'], f),
    ]
    const n = await storeSearch(db, project.id, range, rows)
    await setGoogle(db, project.id, { lastSync: now().toISOString(), error: null })
    return n
  }
  catch (err) {
    const msg = err instanceof SearchError ? err.message : (err as Error).message.slice(0, 300)
    await setGoogle(db, project.id, { error: msg })
    throw new SearchError(msg)
  }
}

export async function syncAllSearch(db: Db, ws: Workspace, appUrl: string, opts: { projectId?: string | null, fetchImpl?: FetchLike } = {}): Promise<{ projects: number, rows: number, errors: string[], sources: SearchSource[] }> {
  const all = await db.select().from(schema.projects).where(and(
    eq(schema.projects.workspaceId, ws.id),
    isNull(schema.projects.archivedAt),
    opts.projectId ? eq(schema.projects.id, opts.projectId) : undefined,
  ))
  let rows = 0
  let projects = 0
  const errors: string[] = []
  const sources = new Set<SearchSource>()
  for (const p of all) {
    const jobs: [SearchSource, () => Promise<number>][] = []
    if (p.setup?.google?.property) jobs.push(['google', () => syncProjectSearch(db, ws, p, appUrl, opts.fetchImpl)])
    if (bingWanted(ws, p)) jobs.push(['bing', () => syncProjectBing(db, ws, p, opts.fetchImpl)])
    if (jobs.length) projects++
    for (const [src, run] of jobs) {
      sources.add(src)
      try {
        rows += await run()
      }
      catch (err) {
        errors.push(`${p.name} (${SEARCH_LABEL[src]}): ${(err as Error).message}`)
      }
    }
  }
  return { projects, rows, errors, sources: [...sources] }
}

export interface SearchTerm {
  query: string
  clicks: number
  impressions: number
  position: number
  page: string | null
}

export interface SearchSummary {
  from: string
  to: string
  clicks: number
  impressions: number
  position: number | null
  series: number[]
  bySource: { source: SearchSource, clicks: number, impressions: number }[]
  top: SearchTerm[]
  chances: SearchTerm[]
  dropped: { page: string, before: number, now: number, impressions: number, source: SearchSource }[]
}

const pos = (sumPos: number, impr: number) => (impr ? Math.round((sumPos / impr) * 10) / 10 : 0)

export async function searchSummary(db: Db, projectId: string, from: string, to: string, opts: { source?: SearchSource | null } = {}): Promise<SearchSummary> {
  const S = schema.searchStats
  const src = opts.source ? eq(S.source, opts.source) : undefined
  const inRange = and(eq(S.projectId, projectId), src, gte(S.day, from), lte(S.day, to))
  const ranked = sql`${S.position} > 0`
  const days = await db.select({
    day: S.day,
    source: S.source,
    clicks: S.clicks,
    impressions: S.impressions,
    pi: sql<number>`(case when ${ranked} then ${S.impressions} else 0 end)::int`,
    wp: sql<number>`(${S.position} * ${S.impressions})::float`,
  }).from(S).where(and(inRange, eq(S.query, ''), eq(S.page, ''))).orderBy(S.day)
  const byDay = new Map<string, number>()
  const bySrc = new Map<SearchSource, { clicks: number, impressions: number }>()
  for (const d of days) {
    byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.clicks)
    const k = d.source as SearchSource
    const cur = bySrc.get(k) ?? { clicks: 0, impressions: 0 }
    cur.clicks += d.clicks
    cur.impressions += d.impressions
    bySrc.set(k, cur)
  }
  const series: number[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) series.push(byDay.get(d) ?? 0)
  const clicks = days.reduce((s, d) => s + d.clicks, 0)
  const impressions = days.reduce((s, d) => s + d.impressions, 0)
  let pi = days.reduce((s, d) => s + d.pi, 0)
  let wp = days.reduce((s, d) => s + d.wp, 0)
  const unranked = [...bySrc.keys()].filter(k => bySrc.get(k)!.impressions && !days.some(d => d.source === k && d.pi))
  if (unranked.length) {
    const [pg] = await db.select({ pi: sql<number>`coalesce(sum(${S.impressions}), 0)::int`, wp: sql<number>`coalesce(sum(${S.position} * ${S.impressions}), 0)::float` }).from(S)
      .where(and(inRange, inArray(S.source, unranked), eq(S.query, ''), sql`${S.page} <> ''`, ranked))
    pi += Number(pg?.pi ?? 0)
    wp += Number(pg?.wp ?? 0)
  }
  const position = pi ? pos(wp, pi) : null
  const bySource = (['google', 'bing'] as const).filter(k => bySrc.has(k)).map(k => ({ source: k, ...bySrc.get(k)! }))

  const terms = await db.select({
    query: S.query,
    clicks: sql<number>`sum(${S.clicks})::int`,
    impressions: sql<number>`sum(${S.impressions})::int`,
    pi: sql<number>`sum(case when ${ranked} then ${S.impressions} else 0 end)::int`,
    wp: sql<number>`sum(${S.position} * ${S.impressions})::float`,
    page: sql<string>`(array_agg(${S.page} order by (${S.page} <> '') desc, ${S.impressions} desc))[1]`,
  }).from(S).where(and(inRange, sql`${S.query} <> ''`)).groupBy(S.query)
  const list: SearchTerm[] = terms.map(t => ({ query: t.query, clicks: t.clicks, impressions: t.impressions, position: pos(t.wp, t.pi), page: t.page || null }))
  const top = [...list].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 10)
  const minImpr = Math.max(10, Math.round(impressions / 200))
  const chances = list.filter(t => t.impressions >= minImpr && t.clicks / t.impressions < 0.03 && t.position > 0 && t.position <= 20).sort((a, b) => b.impressions - a.impressions).slice(0, 10)

  const mid = addDays(to, -13)
  const pages = await db.select({
    source: S.source,
    page: S.page,
    recentImpr: sql<number>`sum(case when ${S.day} >= ${mid} and ${ranked} then ${S.impressions} else 0 end)::int`,
    recentWp: sql<number>`sum(case when ${S.day} >= ${mid} then ${S.position} * ${S.impressions} else 0 end)::float`,
    oldImpr: sql<number>`sum(case when ${S.day} < ${mid} and ${ranked} then ${S.impressions} else 0 end)::int`,
    oldWp: sql<number>`sum(case when ${S.day} < ${mid} then ${S.position} * ${S.impressions} else 0 end)::float`,
  }).from(S).where(and(eq(S.projectId, projectId), src, gte(S.day, addDays(mid, -14)), lte(S.day, to), eq(S.query, ''), sql`${S.page} <> ''`)).groupBy(S.source, S.page)
  const dropped = pages.filter(p => p.recentImpr >= 10 && p.oldImpr >= 10)
    .map(p => ({ page: p.page, before: pos(p.oldWp, p.oldImpr), now: pos(p.recentWp, p.recentImpr), impressions: p.recentImpr + p.oldImpr, source: p.source as SearchSource }))
    .filter(p => p.now - p.before >= 2)
    .sort((a, b) => (b.now - b.before) - (a.now - a.before))
    .filter((p, i, all) => all.findIndex(x => x.page === p.page) === i)
    .slice(0, 5)
  return { from, to, clicks, impressions, position, series, bySource, top, chances, dropped }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}` || '/'
  }
  catch {
    return url
  }
}

const de = (n: number) => String(n).replace('.', ',')

export async function seoDigest(db: Db, project: Pick<Project, 'id'>, d: string, opts: { short?: boolean } = {}): Promise<string> {
  const { from, to } = searchRange(d)
  const s = await searchSummary(db, project.id, from, to)
  const parts: string[] = []
  const names = s.bySource.map(x => SEARCH_LABEL[x.source])
  const label = `${names.join('- und ') || 'Google'}-Suche`
  if (s.impressions) {
    if (opts.short) {
      const terms = s.top.slice(0, 6).map(t => `"${t.query}"`)
      const chances = s.chances.slice(0, 5).map(t => `"${t.query}"`)
      parts.push(`${label}: Leute finden die Seite über ${terms.join(', ') || 'noch kaum Begriffe'}${chances.length ? `; Chancen (oft gezeigt, selten geklickt): ${chances.join(', ')}` : ''}. Passt einer davon zum Thema, verwende ihn natürlich im Titel und in einer Zwischenüberschrift.`)
    }
    else {
      const tools = s.bySource.map(x => (x.source === 'bing' ? 'Bing Webmaster Tools' : 'Search Console')).join(' und ') || 'Search Console'
      const split = s.bySource.length > 1 ? ` (${s.bySource.map(x => `${SEARCH_LABEL[x.source]} ${x.clicks} Klicks, ${x.impressions} Impressionen`).join('; ')})` : ''
      parts.push(`${label} (${tools}, ${from} bis ${to}): ${s.clicks} Klicks, ${s.impressions} Impressionen${s.position ? `, durchschnittliche Position ${de(s.position)}` : ''}${split}.`)
      if (s.top.length) parts.push('Top-Suchbegriffe:', ...s.top.slice(0, 8).map(t => `- "${t.query}": ${t.clicks} Klicks, ${t.impressions} Impressionen, Position ${de(t.position)}`))
      if (s.chances.length) parts.push('Chancen (viele Impressionen, wenig Klicks):', ...s.chances.slice(0, 6).map(t => `- "${t.query}": ${t.impressions} Impressionen, ${t.clicks} Klicks, Position ${de(t.position)}${t.page ? `, Seite ${pathOf(t.page)}` : ''}`))
      if (s.dropped.length) parts.push('Seiten mit gefallener Position (letzte 2 Wochen gegen die 2 davor):', ...s.dropped.map(p => `- ${pathOf(p.page)}: von ${de(p.before)} auf ${de(p.now)}${s.bySource.length > 1 ? ` (${SEARCH_LABEL[p.source]})` : ''}`))
      parts.push('Nutze Chancen-Begriffe für Ratgeber-Artikel (Thema = Suchbegriff) und plane für Seiten mit gefallener Position eine Überarbeitung.')
    }
  }
  if (!opts.short) {
    const [audit] = await db.select().from(schema.seoAudits).where(eq(schema.seoAudits.projectId, project.id))
    const issues = (audit?.result?.issues as { severity: number, label: string, url: string }[] | undefined) ?? []
    if (issues.length) parts.push(`Technische SEO-Prüfung der Website (${audit!.checkedAt.toISOString().slice(0, 10)}), wichtigste Probleme:`, ...issues.slice(0, 6).map(i => `- ${pathOf(i.url)}: ${i.label}`))
  }
  return parts.join('\n')
}
