import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { goalProgress, monthWindow, parseNumber, type GoalProgress } from '../../shared/utils/plan'
import { projectCond, type Access } from './access'
import type { DbOrTx } from './db'
import { schema } from './db'

export type GoalRow = typeof schema.goals.$inferSelect

export interface GoalView {
  id: string
  projectId: string | null
  label: string
  metricKey: string | null
  mode: GoalRow['mode']
  targetValue: number | null
  startDate: string | null
  deadline: string | null
  active: boolean
  note: string | null
  progress: GoalProgress
}

export async function goalCurrent(db: DbOrTx, g: GoalRow, today: string): Promise<number> {
  if (!g.projectId || !g.metricKey) return 0
  const key = g.metricKey
  if (g.mode === 'last') {
    const [row] = await db.select({ v: schema.metrics.value }).from(schema.metrics)
      .where(and(eq(schema.metrics.projectId, g.projectId), eq(schema.metrics.key, key), sql`${schema.metrics.day} <= ${today}`))
      .orderBy(desc(schema.metrics.day)).limit(1)
    return row?.v ?? 0
  }
  const win = g.mode === 'month' ? monthWindow(today) : { from: g.startDate ?? '1970-01-01', to: g.deadline && g.deadline < today ? g.deadline : today }
  // Eingetragene Zahlen im Zeitraum haben Vorrang (oft eine Summe für den ganzen Zeitraum), sonst UTM und Suche (Google und Bing) je Tag.
  const days = await dailyValues(db, g.projectId, key, win.from, win.to, { manualWins: true })
  const [r] = await db.select({ v: sql<number>`coalesce(sum(${schema.results.value}), 0)::float` }).from(schema.results)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.results.taskId))
    .where(and(eq(schema.tasks.projectId, g.projectId), eq(schema.results.metric, key), sql`${schema.results.measuredOn} between ${win.from} and ${win.to}`))
  return [...days.values()].reduce((a, v) => a + v, 0) + Number(r?.v ?? 0)
}

// Eine Zahl je Tag und Kennzahl, für Ziele, Dashboard und Berichte gleich: eingetragener Wert, sonst Kampagnen-Statistik (UTM) und Suche (Klicks aus Google und Bing, je Quelle eigene Zeilen).
export async function dailyValues(db: DbOrTx, projectId: string, key: string, from: string, to: string, opts: { manualWins?: boolean } = {}): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const rows = await db.select({ day: schema.metrics.day, v: schema.metrics.value }).from(schema.metrics)
    .where(and(eq(schema.metrics.projectId, projectId), eq(schema.metrics.key, key), sql`${schema.metrics.day} between ${from} and ${to}`))
  for (const r of rows) out.set(r.day, (out.get(r.day) ?? 0) + Number(r.v))
  const src = AUTO_GOALS[key]
  if (!src || (opts.manualWins && out.size)) return out
  const auto = new Map<string, number>()
  if (src.utm) {
    const U = schema.utmStats
    for (const u of await db.select({ day: U.day, v: sql<number>`coalesce(sum(${U[src.utm]}), 0)::int` }).from(U).where(and(eq(U.projectId, projectId), sql`${U.day} between ${from} and ${to}`)).groupBy(U.day)) auto.set(u.day, (auto.get(u.day) ?? 0) + Number(u.v))
  }
  if (src.search) {
    const S = schema.searchStats
    for (const c of await db.select({ day: S.day, v: sql<number>`coalesce(sum(${S.clicks}), 0)::int` }).from(S).where(and(eq(S.projectId, projectId), eq(S.query, ''), eq(S.page, ''), sql`${S.day} between ${from} and ${to}`)).groupBy(S.day)) auto.set(c.day, (auto.get(c.day) ?? 0) + Number(c.v))
  }
  for (const [day, v] of auto) if (!out.has(day)) out.set(day, v)
  return out
}

// Ziele ohne eingetragene Zahl im Zeitraum: aus Kampagnen-Statistik (UTM) und Suche (Klicks aus Google und Bing) zählen.
export const AUTO_GOALS: Record<string, { utm?: 'visits' | 'signups' | 'purchases', search?: boolean }> = {
  visitors: { utm: 'visits', search: true },
  signups: { utm: 'signups' },
  trials: { utm: 'signups' },
  sales: { utm: 'purchases' },
  premium: { utm: 'purchases' },
}

export async function goalView(db: DbOrTx, g: GoalRow, today: string): Promise<GoalView> {
  const current = await goalCurrent(db, g, today)
  return {
    id: g.id,
    projectId: g.projectId,
    label: g.label,
    metricKey: g.metricKey,
    mode: g.mode,
    targetValue: g.targetValue,
    startDate: g.startDate,
    deadline: g.deadline,
    active: g.active,
    note: g.target12m ? `12 Monate: ${g.target12m}` : null,
    progress: goalProgress(current, g.targetValue, g.startDate, g.deadline, today),
  }
}

export async function listGoals(db: DbOrTx, workspaceId: string, today: string, opts: { projectId?: string | null, access?: Access, activeOnly?: boolean } = {}): Promise<GoalView[]> {
  const conds: (SQL | undefined)[] = [eq(schema.goals.workspaceId, workspaceId)]
  if (opts.projectId) conds.push(eq(schema.goals.projectId, opts.projectId))
  if (opts.access) conds.push(projectCond(opts.access, schema.goals.projectId))
  if (opts.activeOnly !== false) conds.push(eq(schema.goals.active, true))
  const rows = await db.select().from(schema.goals).where(and(...conds)).orderBy(asc(schema.goals.sortOrder), asc(schema.goals.createdAt))
  const out: GoalView[] = []
  for (const g of rows) out.push(await goalView(db, g, today))
  return out
}

const LEGACY_MAP: { re: RegExp, key: string, mode: GoalRow['mode'] }[] = [
  { re: /besucher/i, key: 'visitors', mode: 'month' },
  { re: /testkonten/i, key: 'trials', mode: 'month' },
  { re: /zahlende kunden/i, key: 'customers', mode: 'last' },
  { re: /backlinks|verweisende domains/i, key: 'referring_domains', mode: 'last' },
  { re: /neue konten/i, key: 'signups', mode: 'month' },
  { re: /premium/i, key: 'premium', mode: 'month' },
  { re: /verkäufe/i, key: 'sales', mode: 'month' },
  { re: /künstler/i, key: 'artists', mode: 'last' },
  { re: /newsletter/i, key: 'newsletter', mode: 'last' },
  { re: /follower/i, key: 'followers', mode: 'last' },
]

export function legacyGoalShape(label: string, target3m: string | null): { metricKey: string, mode: GoalRow['mode'], targetValue: number | null } {
  const m = LEGACY_MAP.find(x => x.re.test(label))
  return { metricKey: m?.key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30), mode: m?.mode ?? 'last', targetValue: parseNumber(target3m) }
}

export async function structureLegacyGoals(db: DbOrTx, workspaceId: string, startDate: string, deadline: string): Promise<number> {
  const rows = await db.select().from(schema.goals).where(and(eq(schema.goals.workspaceId, workspaceId), isNull(schema.goals.metricKey)))
  for (const g of rows) {
    const shape = legacyGoalShape(g.label, g.target3m)
    await db.update(schema.goals).set({ ...shape, startDate, deadline }).where(eq(schema.goals.id, g.id))
  }
  return rows.length
}

export interface GoalInput {
  label: string
  metricKey?: string | null
  mode?: GoalRow['mode']
  targetValue?: number | null
  startDate?: string | null
  deadline?: string | null
}

export function metricKeyFor(label: string): string {
  const lower = label.toLowerCase()
  const m = LEGACY_MAP.find(x => x.re.test(lower))
  if (m) return m.key
  if (/registrier|anmeld|sign.?up/.test(lower)) return 'signups'
  if (/hör|play|stream/.test(lower)) return 'plays'
  return lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'ziel'
}

export async function saveGoals(db: DbOrTx, workspaceId: string, projectId: string, goals: GoalInput[], today: string): Promise<GoalRow[]> {
  const out: GoalRow[] = []
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.goals).where(eq(schema.goals.projectId, projectId))
  for (const [i, g] of goals.entries()) {
    const [row] = await db.insert(schema.goals).values({
      workspaceId,
      projectId,
      label: g.label.slice(0, 120),
      metricKey: g.metricKey || metricKeyFor(g.label),
      mode: g.mode ?? 'sum',
      targetValue: g.targetValue ?? null,
      startDate: g.startDate ?? today,
      deadline: g.deadline ?? null,
      sortOrder: n + i,
    }).returning()
    out.push(row!)
  }
  return out
}

export async function goalsByIds(db: DbOrTx, ids: string[]): Promise<GoalRow[]> {
  if (!ids.length) return []
  return db.select().from(schema.goals).where(inArray(schema.goals.id, ids))
}
