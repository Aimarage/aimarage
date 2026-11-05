import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { StrategyChange, StrategyChannel } from '../db/schema'
import { logActivity } from './activity'
import { now } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { activateStrategy, activeStrategy, createStrategyVersion, isSmallChange, normalizeChannel, type ChannelStats } from './strategy'
import { utmSummary } from './traffic'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

// Mindest-Datenlage (letzte 4 Wochen) für Änderungen ohne Freigabe.
export const AUTO_MIN_VISITS = 30
export const AUTO_MIN_EVENTS = 5
export const AUTO_UNDO_BLOCK_DAYS = 28
const CONVERSION = /anmeld|registr|sign.?up|kauf|käuf|purchase|sale/i
export const AUTO_KINDS: StrategyChange['change'][] = ['more', 'less', 'pause', 'resume']
export const AUTO_ACTION = 'strategy_auto_adjusted'
export const AUTO_UNDO_ACTION = 'strategy_auto_undone'

export interface AutoChange extends StrategyChange { activeBefore: boolean }

export function autoStrategyOn(ws: Pick<Workspace, 'settings'>): boolean {
  return ws.settings?.autoStrategy !== false
}

export interface Evidence { visits: number, events: number, enough: boolean }

export function enoughData(visits: number, events: number): boolean {
  return visits >= AUTO_MIN_VISITS || events >= AUTO_MIN_EVENTS
}

export async function strategyEvidence(db: Db, project: Pick<Project, 'id' | 'workspaceId'>, from: string, to: string, stats: Map<string, ChannelStats>): Promise<Evidence> {
  const s = await utmSummary(db, project.workspaceId, [project.id], from, to)
  const results = [...stats.values()].reduce((n, x) => n + Object.entries(x.resultMetrics).filter(([k]) => CONVERSION.test(k)).reduce((m, [, v]) => m + v, 0), 0)
  const visits = s.totals.visits
  const events = s.totals.signups + s.totals.purchases + results
  return { visits, events, enough: enoughData(visits, events) }
}

// Welche Änderungen der Agent selbst umsetzt: nur Takt und Pause/Fortsetzen bestehender Kanäle, nur mit genug Daten
// (Takt um eine Stufe senken entlastet und geht immer). Neue oder gestrichene Kanäle bleiben Vorschlag.
export function splitAuto(changes: StrategyChange[], o: { on: boolean, enough: boolean, blocked: Set<string> }): { auto: StrategyChange[], proposal: StrategyChange[] } {
  const auto: StrategyChange[] = []
  const proposal: StrategyChange[] = []
  for (const c of changes) {
    const ok = o.on && AUTO_KINDS.includes(c.change) && !o.blocked.has(c.channelKey) && (o.enough || (c.change === 'less' && isSmallChange(c)))
    ;(ok ? auto : proposal).push(c)
  }
  return { auto, proposal }
}

export function autoText(changes: Pick<StrategyChange, 'name' | 'change' | 'reason'>[], locale: 'de' | 'en'): string {
  const en = locale === 'en'
  const part = (c: Pick<StrategyChange, 'name' | 'change'>) => {
    if (c.change === 'more') return en ? `more ${c.name}` : `mehr ${c.name}`
    if (c.change === 'less') return en ? `less ${c.name}` : `weniger ${c.name}`
    if (c.change === 'pause') return en ? `${c.name} paused` : `${c.name} pausiert`
    return en ? `${c.name} resumed` : `${c.name} fortgesetzt`
  }
  const reasons = [...new Set(changes.map(c => c.reason.trim().replace(/\.$/, '')).filter(Boolean))].join('; ')
  const why = reasons ? ` (${en ? 'reason' : 'Grund'}: ${reasons.length > 240 ? `${reasons.slice(0, 237)}...` : reasons})` : ''
  return `${en ? 'Strategy adjusted' : 'Strategie angepasst'}: ${changes.map(part).join(', ')}${why}`.replace(/[–—]/g, '-')
}

export async function recordAuto(db: DbOrTx, project: Pick<Project, 'id' | 'workspaceId' | 'name'>, strategyId: string, changes: StrategyChange[], before: StrategyChannel[]): Promise<void> {
  const list: AutoChange[] = changes.map(c => ({ channelKey: c.channelKey, name: c.name, change: c.change, from: c.from ?? null, to: c.to ?? null, reason: c.reason, activeBefore: before.find(b => b.key === c.channelKey)?.active ?? true }))
  await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: 'agent', action: AUTO_ACTION, detail: { title: project.name, strategyId, changes: list, text: autoText(list, 'de'), textEn: autoText(list, 'en') }, at: now() })
}

export async function undoneKeys(db: DbOrTx, projectId: string, days = AUTO_UNDO_BLOCK_DAYS): Promise<Set<string>> {
  const rows = await db.select({ detail: schema.activity.detail }).from(schema.activity).where(and(eq(schema.activity.projectId, projectId), eq(schema.activity.action, AUTO_UNDO_ACTION), gte(schema.activity.createdAt, new Date(now().getTime() - days * 86_400_000))))
  return new Set(rows.flatMap(r => (r.detail.keys as string[] | undefined) ?? []))
}

export interface AutoNote { id: string, projectId: string | null, text: string, textEn: string, at: string }

export async function autoNotes(db: DbOrTx, workspaceId: string, since: Date, projectIds: string[] | null = null): Promise<AutoNote[]> {
  if (projectIds && !projectIds.length) return []
  const rows = await db.select().from(schema.activity).where(and(
    eq(schema.activity.workspaceId, workspaceId),
    eq(schema.activity.action, AUTO_ACTION),
    gte(schema.activity.createdAt, since),
    sql`${schema.activity.detail}->>'undoneAt' is null`,
    projectIds ? inArray(schema.activity.projectId, projectIds) : undefined,
  )).orderBy(desc(schema.activity.createdAt)).limit(10)
  return rows.map(r => ({ id: r.id, projectId: r.projectId, text: String(r.detail.text ?? ''), textEn: String(r.detail.textEn ?? r.detail.text ?? ''), at: r.createdAt.toISOString() }))
}

// Rückgängig: Takt und Pause der betroffenen Kanäle auf den Stand vor der Anpassung, als neue Version.
export async function undoAuto(db: DbOrTx, project: Project, activityId: string, userId: string, today: string): Promise<{ ok: boolean, reason?: 'gone' | 'done' }> {
  const [a] = await db.select().from(schema.activity).where(and(eq(schema.activity.id, activityId), eq(schema.activity.projectId, project.id), eq(schema.activity.action, AUTO_ACTION)))
  if (!a) return { ok: false, reason: 'gone' }
  if (a.detail.undoneAt) return { ok: false, reason: 'done' }
  const list = (a.detail.changes as AutoChange[] | undefined) ?? []
  const cur = await activeStrategy(db, project.id)
  if (cur && list.length) {
    const inverse: StrategyChange[] = []
    const channels = cur.channels.map((c) => {
      const ch = list.find(x => x.channelKey === c.key)
      if (!ch) return c
      const weight = ch.from ?? c.weight
      inverse.push({ channelKey: c.key, name: c.name, change: !ch.activeBefore && c.active ? 'pause' : ch.activeBefore && !c.active ? 'resume' : weight > c.weight ? 'more' : 'less', from: c.weight, to: weight, reason: 'Automatische Anpassung rückgängig gemacht' })
      return normalizeChannel({ ...c, weight, active: ch.activeBefore })
    })
    const s = await createStrategyVersion(db, project, { channels, changes: inverse, summary: cur.summary, status: 'vorschlag', kind: 'manual', byAgent: false })
    await activateStrategy(db, project, s, today, { userId })
  }
  await db.update(schema.activity).set({ detail: { ...a.detail, undoneAt: now().toISOString(), undoneBy: userId } }).where(eq(schema.activity.id, a.id))
  await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: 'user', userId, action: AUTO_UNDO_ACTION, detail: { title: project.name, keys: list.map(c => c.channelKey), text: String(a.detail.text ?? '') }, at: now() })
  return { ok: true }
}
