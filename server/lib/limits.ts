import { and, eq, isNull, sql } from 'drizzle-orm'
import { createError, H3Error } from 'h3'
import type { WorkspaceLimits } from '../db/schema'
import { config } from './config'
import type { DbOrTx } from './db'
import { schema } from './db'
import { checkLimit } from './extensions'
import type { LlmMeter } from './llm-meter'

type Workspace = typeof schema.workspaces.$inferSelect
type WsRef = Pick<Workspace, 'id' | 'limits'>

export type LimitKind = keyof WorkspaceLimits

const MESSAGES: Record<LimitKind, string> = {
  projects: 'Höchstzahl an Projekten erreicht',
  members: 'Höchstzahl an Nutzern erreicht',
  accounts: 'Höchstzahl an Konten erreicht',
  llmEurMonth: 'KI-Budget für diesen Monat aufgebraucht',
  storageMb: 'Speicherplatz aufgebraucht',
  strongModel: 'Starkes Modell ist im aktuellen Tarif nicht enthalten',
  mcp: 'MCP/API ist im aktuellen Tarif nicht enthalten',
  clientLinks: 'Kundenlinks sind im aktuellen Tarif nicht enthalten',
  onePerPlatform: 'Je Projekt ist nur ein Konto pro Plattform möglich',
  socialAccounts: 'Höchstzahl an Social-Konten im Tarif erreicht',
  braveCallsPerDay: 'Tagesgrenze der Websuche für diesen Arbeitsbereich erreicht',
  servicesEurMonth: 'Budget für Dienste (Websuche, Posten) für diesen Monat aufgebraucht',
}

export class LimitError extends H3Error {
  readonly kind: LimitKind

  constructor(kind: LimitKind, message = MESSAGES[kind]) {
    super(message)
    this.kind = kind
    this.statusCode = 402
    this.statusMessage = message
    this.data = { code: 'limit', kind }
  }
}

export function isLimitError(err: unknown): err is LimitError {
  return err instanceof LimitError
}

export function limitsOf(ws: Pick<Workspace, 'limits'>): WorkspaceLimits | null {
  return ws.limits ?? null
}

export function numLimit(ws: Pick<Workspace, 'limits'>, kind: 'projects' | 'members' | 'accounts' | 'llmEurMonth' | 'storageMb' | 'socialAccounts' | 'braveCallsPerDay' | 'servicesEurMonth'): number | null {
  const v = ws.limits?.[kind]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

async function extension(db: DbOrTx, ws: WsRef, kind: LimitKind, amount?: number): Promise<void> {
  await checkLimit(db, { workspaceId: ws.id, kind, amount })
}

async function countOf(db: DbOrTx, query: ReturnType<typeof sql>): Promise<number> {
  const res = await db.execute(query)
  const row = (res as unknown as { rows: { n: number | string | null }[] }).rows[0]
  return Number(row?.n ?? 0)
}

// Pausierter Workspace (ohne laufenden Tarif): nur lesen. Keine neuen Projekte (außer der einen Vorschau),
// keine Konten, keine Uploads. Die Oberfläche zeigt dafür den Hinweis 'trial'.

export function pausedLimit(kind: LimitKind, message = 'Erst mit laufendem Tarif verfügbar'): LimitError {
  const err = new LimitError(kind, message)
  err.data = { code: 'limit', kind: 'trial' }
  return err
}

export async function assertActive(db: DbOrTx, workspaceId: string, kind: LimitKind): Promise<void> {
  const [w] = await db.select({ pausedAt: schema.workspaces.pausedAt }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1)
  if (w?.pausedAt) throw pausedLimit(kind)
}

// Projekte

export async function projectsUsed(db: DbOrTx, workspaceId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.projects).where(and(eq(schema.projects.workspaceId, workspaceId), isNull(schema.projects.archivedAt)))
  return r?.n ?? 0
}

export async function assertProjectLimit(db: DbOrTx, ws: WsRef, opts: { preview?: boolean } = {}): Promise<void> {
  if (!opts.preview) await assertActive(db, ws.id, 'projects')
  const max = numLimit(ws, 'projects')
  if (max !== null && (await projectsUsed(db, ws.id)) + 1 > max) throw new LimitError('projects')
  await extension(db, ws, 'projects', 1)
}

// Konten: Social-Verbindungen, Konten des Posting-Dienstes, Postfächer und Blog-Schnittstellen

export async function accountsUsed(db: DbOrTx, ws: Pick<Workspace, 'id' | 'settings'>): Promise<number> {
  const conns = ws.settings?.connections?.length ?? 0
  const social = ws.settings?.social?.accounts?.length ?? 0
  const [r] = await db.select({
    mail: sql<number>`count(*) filter (where ${schema.projects.setup}->'mail' is not null and ${schema.projects.setup}->'mail' <> 'null'::jsonb)::int`,
    blog: sql<number>`count(*) filter (where ${schema.projects.setup}->'blogApi' is not null and ${schema.projects.setup}->'blogApi' <> 'null'::jsonb)::int`,
  }).from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))
  return conns + social + (r?.mail ?? 0) + (r?.blog ?? 0)
}

export async function assertAccountLimit(db: DbOrTx, ws: Pick<Workspace, 'id' | 'limits' | 'settings'>, adding = 1): Promise<void> {
  if (adding > 0) await assertActive(db, ws.id, 'accounts')
  const max = numLimit(ws, 'accounts')
  if (max !== null && (await accountsUsed(db, ws)) + adding > max) throw new LimitError('accounts')
  await extension(db, ws, 'accounts', adding)
}

// Social-Konten: eigene Verbindungen (Bluesky, Mastodon, Telegram, eigene Apps) plus Konten des Posting-Dienstes.
// Gehostet nur die Konten des eigenen Zernio-Profils.

export function socialAccountsUsed(ws: Pick<Workspace, 'settings'>): number {
  const s = ws.settings?.social
  const pid = s?.hosted?.profileId
  const service = (s?.accounts ?? []).filter(a => !pid || a.profileId === pid).length
  return (ws.settings?.connections?.length ?? 0) + service
}

export async function assertSocialAccountLimit(db: DbOrTx, ws: Pick<Workspace, 'id' | 'limits' | 'settings'>, adding = 1): Promise<void> {
  if (adding > 0) await assertActive(db, ws.id, 'socialAccounts')
  const max = numLimit(ws, 'socialAccounts')
  if (max !== null && socialAccountsUsed(ws) + adding > max) throw new LimitError('socialAccounts')
  await extension(db, ws, 'socialAccounts', adding)
}

export function socialAccountUsage(ws: Pick<Workspace, 'limits' | 'settings'>): { used: number, limit: number | null } {
  return { used: socialAccountsUsed(ws), limit: numLimit(ws, 'socialAccounts') }
}

// Ein Konto je Plattform und Projekt (gehosteter Betrieb)

type ProjectSocialRef = { profileIds?: string[], accountIds?: string[] } | null | undefined

export function platformKey(platform: string): string {
  const p = platform.trim().toLowerCase()
  return p === 'twitter' ? 'x' : p
}

export function projectPlatformAccounts(ws: Pick<Workspace, 'settings'>, social: ProjectSocialRef): { id: string, platform: string }[] {
  const ids = new Set(social?.accountIds ?? [])
  const own = (ws.settings?.connections ?? []).filter(c => ids.has(c.id)).map(c => ({ id: c.id, platform: platformKey(c.platform) }))
  const prof = new Set(social?.profileIds ?? [])
  const up = (ws.settings?.social?.accounts ?? []).filter(a => ids.has(a.id) || (a.profileId && prof.has(a.profileId))).map(a => ({ id: a.id, platform: platformKey(a.platform) }))
  return [...own, ...up]
}

export function platformClash(ws: Pick<Workspace, 'limits' | 'settings'>, before: ProjectSocialRef, after: ProjectSocialRef): string | null {
  if (ws.limits?.onePerPlatform !== true) return null
  const old = new Set(projectPlatformAccounts(ws, before).map(a => a.id))
  const list = projectPlatformAccounts(ws, after)
  for (const a of list) {
    if (old.has(a.id)) continue
    if (list.some(b => b.id !== a.id && b.platform === a.platform)) return a.platform
  }
  return null
}

export function platformTaken(ws: Pick<Workspace, 'limits' | 'settings'>, social: ProjectSocialRef, platform: string, exceptId: string | null = null): boolean {
  if (ws.limits?.onePerPlatform !== true) return false
  const key = platformKey(platform)
  return projectPlatformAccounts(ws, social).some(a => a.platform === key && a.id !== exceptId)
}

export function assertPlatformFree(ws: Pick<Workspace, 'limits' | 'settings'>, before: ProjectSocialRef, after: ProjectSocialRef): void {
  const clash = platformClash(ws, before, after)
  if (clash) throw createError({ statusCode: 409, statusMessage: `Dieses Projekt hat schon ein Konto für ${clash}. Je Projekt geht ein Konto pro Plattform.`, data: { code: 'one_per_platform', platform: clash } })
}

// Nutzer (Team-Einladungen kommen im SaaS-Teil)

export async function membersUsed(db: DbOrTx, workspaceId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId))
  return r?.n ?? 0
}

export async function assertMemberLimit(db: DbOrTx, ws: WsRef, adding = 1): Promise<void> {
  const max = numLimit(ws, 'members')
  if (max !== null && (await membersUsed(db, ws.id)) + adding > max) throw new LimitError('members')
  await extension(db, ws, 'members', adding)
}

// Speicher: gezählter Stand der Ablage (Job storage_usage) oder Summe der gespeicherten Größen, je nachdem was größer ist

export async function storedBytes(db: DbOrTx, workspaceId: string): Promise<number> {
  return countOf(db, sql`
    select (
      coalesce((select sum(size) from media_library where workspace_id = ${workspaceId}), 0)
      + coalesce((select sum(size) from project_documents where workspace_id = ${workspaceId}), 0)
      + coalesce((select sum(coalesce((m->>'size')::bigint, 0)) from drafts d join tasks t on t.id = d.task_id cross join lateral jsonb_array_elements(d.media) m where t.workspace_id = ${workspaceId}), 0)
    )::bigint as n
  `)
}

export async function storageUsed(db: DbOrTx, ws: Pick<Workspace, 'id' | 'storageBytes'>): Promise<number> {
  return Math.max(ws.storageBytes ?? 0, await storedBytes(db, ws.id))
}

export async function assertStorage(db: DbOrTx, ws: Pick<Workspace, 'id' | 'limits' | 'storageBytes'>, bytes: number): Promise<void> {
  await assertActive(db, ws.id, 'storageMb')
  const max = numLimit(ws, 'storageMb')
  if (max !== null && (await storageUsed(db, ws)) + bytes > max * 1024 * 1024) throw new LimitError('storageMb')
  await extension(db, ws, 'storageMb', bytes)
}

// KI-Budget: Summe agent_runs.cost_eur im laufenden Monat ohne den Anteil über eigene KI-Schlüssel (own_cost_eur), 60 s gecacht

const SPENT_TTL_MS = 60_000
const spentCache = new Map<string, { at: number, value: number }>()

export function resetLimitCache(): void {
  spentCache.clear()
}

export async function llmSpentMonth(db: DbOrTx, ws: Pick<Workspace, 'id' | 'timezone'>, fresh = false): Promise<number> {
  const hit = spentCache.get(ws.id)
  if (!fresh && hit && Date.now() - hit.at < SPENT_TTL_MS) return hit.value
  const tz = ws.timezone || 'Europe/Vienna'
  const value = await countOf(db, sql`
    select coalesce(sum(cost_eur - own_cost_eur), 0)::float8 as n from agent_runs
    where workspace_id = ${ws.id} and started_at >= (date_trunc('month', now() at time zone ${tz}) at time zone ${tz})
  `)
  spentCache.set(ws.id, { at: Date.now(), value })
  return value
}

export async function assertLlmBudget(db: DbOrTx, ws: Pick<Workspace, 'id' | 'limits' | 'timezone'>, running = 0): Promise<void> {
  const max = numLimit(ws, 'llmEurMonth')
  if (max !== null && (await llmSpentMonth(db, ws)) + running >= max) throw new LimitError('llmEurMonth')
  await extension(db, ws, 'llmEurMonth', running)
}

export function budgetGuard(db: DbOrTx, ws: Pick<Workspace, 'id' | 'limits' | 'timezone'>, meter: () => LlmMeter | undefined): () => Promise<void> {
  return async () => {
    const m = meter()
    const running = m ? m.calls.reduce((s, c) => s + (c.own ? 0 : c.costEur), 0) : 0
    await assertLlmBudget(db, ws, running)
  }
}

export async function llmUsage(db: DbOrTx, ws: Pick<Workspace, 'id' | 'limits' | 'timezone'>): Promise<{ spentEur: number, limitEur: number | null, percent: number | null }> {
  const spentEur = await llmSpentMonth(db, ws)
  const limitEur = numLimit(ws, 'llmEurMonth')
  return { spentEur, limitEur, percent: limitEur ? Math.round((spentEur / limitEur) * 100) : null }
}

// Schalter

export function strongModelAllowed(ws: Pick<Workspace, 'limits'>): boolean {
  return ws.limits?.strongModel !== false
}

export function assertStrongModel(ws: Pick<Workspace, 'limits'>): void {
  if (!strongModelAllowed(ws)) throw new LimitError('strongModel')
}

export function mcpAllowed(ws: Pick<Workspace, 'limits'> & Partial<Pick<Workspace, 'pausedAt' | 'previewUsedAt'>>, scope: 'read' | 'write'): boolean {
  if (ws.pausedAt && ws.previewUsedAt) return false
  const v = ws.limits?.mcp
  if (v === false) return false
  if (v === 'read') return scope === 'read'
  return true
}

export function assertMcp(ws: Pick<Workspace, 'limits'>, scope: 'read' | 'write'): void {
  if (!mcpAllowed(ws, scope)) throw new LimitError('mcp')
}

export function assertClientLinks(ws: Pick<Workspace, 'limits'> & Partial<Pick<Workspace, 'pausedAt' | 'previewUsedAt'>>): void {
  if (ws.pausedAt && ws.previewUsedAt) throw pausedLimit('clientLinks')
  if (ws.limits?.clientLinks === false) throw new LimitError('clientLinks')
}

export function upgradeUrl(): string {
  return `${config.appUrl}/abo`
}
