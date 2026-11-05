import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { addDays, isValidIso } from '../../shared/utils/dates'
import type { ProjectStats } from '../db/schema'
import { now, today } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { keyHint, redactKey } from './llm'
import { decryptSecret, encryptSecret } from './secret'
import { assertPublicHost, SITE_UA } from './site'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export class TrafficError extends Error {}

export const FIRST_DAYS = 30
export const SYNC_DAYS = 2
const MAX_ROWS = 20_000

function ctxOf(workspaceId: string, projectId: string, url: string): string {
  return `utm-stats|${workspaceId}|${projectId}|${url}`
}

export function normalizeStatsUrl(raw: string): string {
  const u = new URL(raw.trim())
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TrafficError('Nur http(s)-Adressen')
  u.search = ''
  u.hash = ''
  u.username = ''
  u.password = ''
  return u.toString()
}

export function normalizePrefix(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase().replace(/[\s_.+/]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').slice(0, 64)
  return v || null
}

export function matchesPrefix(row: Pick<UtmRow, 'campaign'>, prefix: string | null | undefined): boolean {
  return !prefix || row.campaign.startsWith(prefix)
}

export function buildStats(workspaceId: string, projectId: string, cur: ProjectStats | null | undefined, input: { url: string, token?: string | null, campaignPrefix?: string | null }, at = new Date()): ProjectStats {
  const url = normalizeStatsUrl(input.url)
  const same = cur?.mode !== 'counter' && cur?.url === url
  const token = input.token?.trim()
  const secret = token
    ? { enc: encryptSecret(token, ctxOf(workspaceId, projectId, url)), hint: keyHint(token), setAt: at.toISOString() }
    : same ? cur?.secret ?? null : null
  const campaignPrefix = input.campaignPrefix === undefined ? cur?.campaignPrefix ?? null : normalizePrefix(input.campaignPrefix)
  const prefixChanged = campaignPrefix !== (cur?.campaignPrefix ?? null)
  return {
    mode: 'api',
    url,
    site: cur?.site ?? null,
    campaignPrefix,
    secret,
    checkedAt: same && !token ? cur?.checkedAt ?? null : null,
    error: same && !token ? cur?.error ?? null : null,
    lastSync: same && !prefixChanged ? cur?.lastSync ?? null : null,
  }
}

export function copyStatsToken(workspaceId: string, from: { id: string, stats: ProjectStats | null | undefined }, to: { id: string, stats: ProjectStats }, at = new Date()): ProjectStats {
  if (!from.stats?.secret) throw new TrafficError('Das andere Projekt hat keinen Zugang gespeichert')
  if (from.stats.url !== to.stats.url) throw new TrafficError('Zugang nur bei gleicher Statistik-Adresse übernehmbar')
  const token = statsToken(workspaceId, from.id, from.stats)
  if (!token) throw new TrafficError('Zugang des anderen Projekts ist unlesbar')
  return { ...to.stats, secret: { enc: encryptSecret(token, ctxOf(workspaceId, to.id, to.stats.url)), hint: from.stats.secret.hint, setAt: at.toISOString() }, checkedAt: null, error: null, lastSync: null }
}

export function statsToken(workspaceId: string, projectId: string, s: ProjectStats | null | undefined): string | null {
  if (!s?.secret) return null
  return decryptSecret(s.secret.enc, ctxOf(workspaceId, projectId, s.url))
}

export function isCounter(s: ProjectStats | null | undefined): boolean {
  return s?.mode === 'counter' && !!s.site
}

export function statsConfigured(s: ProjectStats | null | undefined): boolean {
  return !!s?.secret || isCounter(s)
}

export function publicStats(s: ProjectStats | null | undefined) {
  if (!s) return null
  return { mode: isCounter(s) ? 'counter' as const : 'api' as const, site: isCounter(s) ? s.site! : null, url: s.url, campaignPrefix: s.campaignPrefix ?? null, hasToken: !!s.secret, hint: s.secret?.hint ?? '', setAt: s.secret?.setAt ?? null, checkedAt: s.checkedAt ?? null, error: s.error ?? null, lastSync: s.lastSync ?? null }
}

const count = z.coerce.number().int().min(0).catch(0)
const text = z.string().max(200).catch('').transform(v => v.trim().toLowerCase())
const rowSchema = z.object({
  day: z.string().refine(isValidIso),
  source: text,
  medium: text,
  campaign: text,
  content: text,
  visits: count,
  signups: count,
  interests: count,
  purchases: count,
  netCents: z.coerce.number().int().catch(0),
})
const responseSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  currency: z.string().optional(),
  rows: z.array(z.unknown()).max(MAX_ROWS),
})

export type UtmRow = z.infer<typeof rowSchema>

export interface UtmFetch {
  from: string
  to: string
  currency: string
  rows: UtmRow[]
}

function httpError(status: number): string {
  if (status === 401 || status === 403) return `Token abgelehnt (${status}), bitte neu eintragen`
  if (status === 404) return 'Adresse nicht gefunden (404)'
  if (status === 429) return 'Zu viele Abrufe (429), später erneut'
  return `Seite antwortet mit Fehler ${status}`
}

export async function fetchUtm(url: string, token: string, range: { from: string, to: string }, fetchImpl: FetchLike = fetch, timeoutMs = 20_000): Promise<UtmFetch> {
  const u = new URL(url)
  u.searchParams.set('from', range.from)
  u.searchParams.set('to', range.to)
  await assertPublicHost(u.toString())
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetchImpl(u.toString(), { method: 'GET', redirect: 'error', signal: ctrl.signal, headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'User-Agent': SITE_UA } })
  }
  catch (err) {
    const e = err as Error
    throw new TrafficError(redactKey(e.name === 'AbortError' ? 'Zeitüberschreitung beim Abruf' : `Abruf fehlgeschlagen: ${e.message}`, token).slice(0, 300))
  }
  finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new TrafficError(httpError(res.status))
  let body: unknown
  try {
    body = await res.json()
  }
  catch {
    throw new TrafficError('Antwort ist kein JSON')
  }
  const parsed = responseSchema.safeParse(body)
  if (!parsed.success) throw new TrafficError('Antwort hat kein "rows"-Feld')
  const rows: UtmRow[] = []
  for (const r of parsed.data.rows) {
    const x = rowSchema.safeParse(r)
    if (x.success && x.data.day >= range.from && x.data.day <= range.to) rows.push(x.data)
  }
  return { from: range.from, to: range.to, currency: parsed.data.currency ?? 'EUR', rows }
}

export function syncRange(s: ProjectStats, d: string, first = !s.lastSync): { from: string, to: string } {
  return { from: addDays(d, -((first ? FIRST_DAYS : SYNC_DAYS) - 1)), to: d }
}

async function setStats(db: Db, projectId: string, patch: Partial<ProjectStats>): Promise<void> {
  const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, projectId))
  if (!p?.setup?.stats) return
  await db.update(schema.projects).set({ setup: { ...p.setup, stats: { ...p.setup.stats, ...patch } } }).where(eq(schema.projects.id, projectId))
}

function merge(rows: UtmRow[]): UtmRow[] {
  const m = new Map<string, UtmRow>()
  for (const r of rows) {
    const k = [r.day, r.source || 'direkt', r.medium, r.campaign, r.content].join('\u0000')
    const cur = m.get(k)
    if (!cur) m.set(k, { ...r, source: r.source || 'direkt' })
    else for (const f of ['visits', 'signups', 'interests', 'purchases', 'netCents'] as const) cur[f] += r[f]
  }
  return [...m.values()]
}

export async function storeUtm(db: Db, projectId: string, range: { from: string, to: string }, rows: UtmRow[]): Promise<number> {
  const list = merge(rows)
  await db.transaction(async (tx) => {
    await tx.delete(schema.utmStats).where(and(eq(schema.utmStats.projectId, projectId), gte(schema.utmStats.day, range.from), lte(schema.utmStats.day, range.to)))
    for (let i = 0; i < list.length; i += 500) {
      await tx.insert(schema.utmStats).values(list.slice(i, i + 500).map(r => ({ projectId, ...r, updatedAt: now() })))
        .onConflictDoUpdate({
          target: [schema.utmStats.projectId, schema.utmStats.day, schema.utmStats.source, schema.utmStats.medium, schema.utmStats.campaign, schema.utmStats.content, schema.utmStats.path],
          set: { visits: sql`excluded.visits`, signups: sql`excluded.signups`, interests: sql`excluded.interests`, purchases: sql`excluded.purchases`, netCents: sql`excluded.net_cents`, updatedAt: sql`excluded.updated_at` },
        })
    }
  })
  return list.length
}

export async function checkStats(db: Db, ws: Workspace, project: Project, fetchImpl?: FetchLike): Promise<{ ok: boolean, rows: number, days: number, error: string | null }> {
  const s = project.setup?.stats
  if (!s) throw new TrafficError('Keine Statistik-Adresse eingetragen')
  const token = statsToken(ws.id, project.id, s)
  if (!token) throw new TrafficError(s.secret ? 'Token unlesbar, bitte neu eintragen' : 'Lese-Token fehlt')
  const d = today(ws.timezone)
  try {
    const r = await fetchUtm(s.url, token, syncRange(s, d, true), fetchImpl)
    await setStats(db, project.id, { checkedAt: now().toISOString(), error: null })
    return { ok: true, rows: r.rows.filter(x => matchesPrefix(x, s.campaignPrefix)).length, days: FIRST_DAYS, error: null }
  }
  catch (err) {
    const msg = err instanceof TrafficError ? err.message : redactKey((err as Error).message, token).slice(0, 300)
    await setStats(db, project.id, { checkedAt: now().toISOString(), error: msg })
    return { ok: false, rows: 0, days: FIRST_DAYS, error: msg }
  }
}

export async function syncProjectUtm(db: Db, ws: Workspace, project: Project, fetchImpl?: FetchLike): Promise<number> {
  const s = project.setup?.stats
  if (!s) throw new TrafficError('Keine Statistik-Adresse eingetragen')
  const token = statsToken(ws.id, project.id, s)
  if (!token) throw new TrafficError(s.secret ? 'Token unlesbar, bitte neu eintragen' : 'Lese-Token fehlt')
  const range = syncRange(s, today(ws.timezone))
  try {
    const r = await fetchUtm(s.url, token, range, fetchImpl)
    const n = await storeUtm(db, project.id, range, r.rows.filter(x => matchesPrefix(x, s.campaignPrefix)))
    await setStats(db, project.id, { lastSync: now().toISOString(), error: null })
    return n
  }
  catch (err) {
    const msg = err instanceof TrafficError ? err.message : redactKey((err as Error).message, token).slice(0, 300)
    await setStats(db, project.id, { error: msg })
    throw new TrafficError(msg)
  }
}

export async function syncAllUtm(db: Db, ws: Workspace, opts: { projectId?: string | null, fetchImpl?: FetchLike } = {}): Promise<{ projects: number, rows: number, errors: string[] }> {
  const projects = await db.select().from(schema.projects).where(and(
    eq(schema.projects.workspaceId, ws.id),
    isNull(schema.projects.archivedAt),
    opts.projectId ? eq(schema.projects.id, opts.projectId) : undefined,
    sql`${schema.projects.setup}->'stats'->>'secret' is not null`,
    sql`coalesce(${schema.projects.setup}->'stats'->>'mode', 'api') <> 'counter'`,
  ))
  let rows = 0
  const errors: string[] = []
  for (const p of projects) {
    try {
      rows += await syncProjectUtm(db, ws, p, opts.fetchImpl)
    }
    catch (err) {
      errors.push(`${p.name}: ${(err as Error).message}`)
    }
  }
  return { projects: projects.length, rows, errors }
}

export interface UtmNumbers {
  visits: number
  signups: number
  interests: number
  purchases: number
  netCents: number
}

export interface UtmCampaign extends UtmNumbers {
  campaign: string
  medium: string
  task: { id: string, code: string, title: string, projectId: string | null, strategyChannel: string | null } | null
}

export interface UtmSource extends UtmNumbers {
  source: string
  campaigns: UtmCampaign[]
}

export interface UtmSummary {
  from: string
  to: string
  totals: UtmNumbers
  sources: UtmSource[]
}

function zero(): UtmNumbers {
  return { visits: 0, signups: 0, interests: 0, purchases: 0, netCents: 0 }
}

function add(a: UtmNumbers, b: UtmNumbers): void {
  a.visits += b.visits
  a.signups += b.signups
  a.interests += b.interests
  a.purchases += b.purchases
  a.netCents += b.netCents
}

export async function utmSummary(db: Db, workspaceId: string, projectIds: string[], from: string, to: string): Promise<UtmSummary> {
  const out: UtmSummary = { from, to, totals: zero(), sources: [] }
  if (!projectIds.length) return out
  const rows = await db.select({
    source: schema.utmStats.source,
    medium: schema.utmStats.medium,
    campaign: schema.utmStats.campaign,
    visits: sql<number>`sum(${schema.utmStats.visits})::int`,
    signups: sql<number>`sum(${schema.utmStats.signups})::int`,
    interests: sql<number>`sum(${schema.utmStats.interests})::int`,
    purchases: sql<number>`sum(${schema.utmStats.purchases})::int`,
    netCents: sql<number>`sum(${schema.utmStats.netCents})::int`,
  }).from(schema.utmStats)
    .where(and(inArray(schema.utmStats.projectId, projectIds), gte(schema.utmStats.day, from), lte(schema.utmStats.day, to)))
    .groupBy(schema.utmStats.source, schema.utmStats.medium, schema.utmStats.campaign)
  const codes = [...new Set(rows.map(r => r.campaign).filter(Boolean))]
  const tasks = codes.length
    ? await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, projectId: schema.tasks.projectId, strategyChannel: schema.tasks.strategyChannel }).from(schema.tasks)
        .where(and(eq(schema.tasks.workspaceId, workspaceId), inArray(schema.tasks.projectId, projectIds), inArray(sql`lower(${schema.tasks.code})`, codes)))
    : []
  const byCode = new Map(tasks.map(t => [t.code.toLowerCase(), t]))
  const bySource = new Map<string, UtmSource>()
  for (const r of rows) {
    const src = bySource.get(r.source) ?? { source: r.source, ...zero(), campaigns: [] }
    bySource.set(r.source, src)
    add(src, r)
    add(out.totals, r)
    src.campaigns.push({ campaign: r.campaign, medium: r.medium, visits: r.visits, signups: r.signups, interests: r.interests, purchases: r.purchases, netCents: r.netCents, task: byCode.get(r.campaign) ?? null })
  }
  const rank = (a: UtmNumbers, b: UtmNumbers) => b.netCents - a.netCents || b.purchases - a.purchases || b.signups - a.signups || b.visits - a.visits
  out.sources = [...bySource.values()].sort(rank)
  for (const s of out.sources) s.campaigns.sort(rank)
  return out
}

function euro(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} EUR`
}

function numbers(n: UtmNumbers): string {
  return [`${n.visits} Besuche`, `${n.signups} Anmeldungen`, n.interests ? `${n.interests} Interessenten` : '', `${n.purchases} Käufe`, n.netCents ? euro(n.netCents) : ''].filter(Boolean).join(', ')
}

export async function trafficDigest(db: Db, project: Pick<Project, 'id' | 'workspaceId'>, from: string, to: string, maxSources = 8): Promise<string> {
  const s = await utmSummary(db, project.workspaceId, [project.id], from, to)
  if (!s.sources.length) return ''
  const lines = s.sources.slice(0, maxSources).map((x) => {
    const top = x.campaigns.filter(c => c.task && (c.signups || c.purchases || c.visits)).slice(0, 2).map(c => c.task!.code)
    return `- ${x.source}: ${numbers(x)}${top.length ? ` (stärkste Aufgaben: ${top.join(', ')})` : ''}`
  })
  const byChannel = new Map<string, UtmNumbers>()
  for (const x of s.sources) {
    for (const c of x.campaigns) {
      const key = c.task?.strategyChannel
      if (!key) continue
      const n = byChannel.get(key) ?? zero()
      add(n, c)
      byChannel.set(key, n)
    }
  }
  const ch = [...byChannel.entries()].sort((a, b) => b[1].netCents - a[1].netCents || b[1].signups - a[1].signups || b[1].visits - a[1].visits).slice(0, 8)
  return [
    `Besucher über UTM-Links (Zahlen der Projektseite, ${from} bis ${to}, gesamt ${numbers(s.totals)}):`,
    ...lines,
    ...(ch.length ? ['Je Strategie-Kanal (über den Aufgaben-Code in utm_campaign):', ...ch.map(([k, n]) => `- ${k}: ${numbers(n)}`)] : []),
  ].join('\n')
}

export function trafficRange(d: string, days = 28): { from: string, to: string } {
  return { from: addDays(d, -days), to: addDays(d, -1) }
}
