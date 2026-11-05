import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import { addDays, diffDays, minutesOf, startOfWeek, timeIn, todayIn } from '../../shared/utils/dates'
import { DONE_STATUSES } from '../../shared/utils/domain'
import { siteHost } from '../../shared/utils/utm'
import { MAX_WEIGHT, WEIGHT_PER_WEEK } from '../../shared/utils/plan'
import type { ExperimentMetric, ExperimentResult, ExperimentVariable, StrategyWeekDimension } from '../db/schema'
import { logActivity } from './activity'
import { now } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { effectiveAutonomy } from './outlets'
import { socialTarget } from './publish'
import { activeStrategy, applyStrategy, changeStrategy, createStrategyVersion, pendingProposal, type StrategyRow } from './strategy'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
export type ExperimentRow = typeof schema.experiments.$inferSelect
export type InsightRow = typeof schema.insights.$inferSelect

// Mindestens so viele gemessene Beiträge je Variante, sonst "zu wenig Daten".
export const MIN_PER_ARM = 3
// Ab dieser relativen Differenz gilt eine Variante als besser oder schlechter.
export const THRESHOLD = 0.2
export const RUN_DAYS = 14
export const EXTEND_DAYS = 7
export const MAX_EXTENSIONS = 2
// Ergebnisse brauchen ein paar Tage, bis Reichweite und Likes stehen.
export const SETTLE_DAYS = 2
export const SMALL_VARIABLES: ExperimentVariable[] = ['uhrzeit', 'format', 'thema']
export const TIME_VARIANTS = ['18:00', '10:00', '12:30', '08:30', '20:00']
export const FORMAT_VARIANTS = ['bild', 'text', 'video'] as const
export const EXPERIMENT_MARK = 'Experiment (Variante B):'
const MEDIA_REQUIRED = ['instagram', 'tiktok', 'youtube', 'pinterest']

export const FORMAT_LABELS: Record<string, string> = { bild: 'Beitrag mit Bild', text: 'reiner Textbeitrag', video: 'Beitrag mit Video', artikel: 'Artikel', mail: 'Mail' }
export const METRIC_LABELS: Record<ExperimentMetric, string> = { interaktionen: 'Interaktionen', reichweite: 'Reichweite', klicks: 'Klicks', besuche: 'Besuche', anmeldungen: 'Anmeldungen' }

// Kennzahlen je Beitrag

export interface PostFact {
  taskId: string
  code: string
  dueDate: string
  channelKey: string
  category: string
  platforms: string[]
  format: string
  bucket: string | null
  arm: 'A' | 'B' | null
  experimentId: string | null
  measured: boolean
  reach: number
  interactions: number
  clicks: number
  visits: number
  signups: number
  purchases: number
}

export function timeBucket(time: string | null | undefined): string | null {
  if (!time || !/^\d{1,2}:\d{2}/.test(time)) return null
  const h = Math.floor(minutesOf(time) / 60)
  const start = Math.floor(h / 3) * 3
  return `${String(start).padStart(2, '0')}-${String(start + 3).padStart(2, '0')}`
}

export function formatOf(kind: string | null | undefined, mimes: string[]): string {
  if (kind === 'article') return 'artikel'
  if (kind === 'mail') return 'mail'
  if (mimes.some(m => m.startsWith('video/'))) return 'video'
  if (mimes.some(m => m.startsWith('image/'))) return 'bild'
  return 'text'
}

export async function postFacts(db: DbOrTx, ws: Pick<Workspace, 'timezone'>, projectId: string, from: string, to: string, opts: { experimentId?: string } = {}): Promise<PostFact[]> {
  const tasks = await db.select({
    id: schema.tasks.id,
    code: schema.tasks.code,
    dueDate: schema.tasks.dueDate,
    dueTime: schema.tasks.dueTime,
    strategyChannel: schema.tasks.strategyChannel,
    category: schema.tasks.category,
    draftKind: schema.tasks.draftKind,
    experimentId: schema.tasks.experimentId,
    experimentArm: schema.tasks.experimentArm,
  }).from(schema.tasks).where(and(
    eq(schema.tasks.projectId, projectId),
    inArray(schema.tasks.status, DONE_STATUSES),
    gte(schema.tasks.dueDate, from),
    lte(schema.tasks.dueDate, to),
    opts.experimentId ? eq(schema.tasks.experimentId, opts.experimentId) : undefined,
  ))
  if (!tasks.length) return []
  const ids = tasks.map(t => t.id)
  const res = await db.select({ taskId: schema.results.taskId, metric: schema.results.metric, value: sql<number>`max(${schema.results.value})::float` }).from(schema.results)
    .where(inArray(schema.results.taskId, ids)).groupBy(schema.results.taskId, schema.results.metric)
  const metrics = new Map<string, Record<string, number>>()
  for (const r of res) metrics.set(r.taskId, { ...metrics.get(r.taskId), [r.metric]: Number(r.value) })
  const links = await db.select({ taskId: schema.taskLinks.taskId, platform: schema.taskLinks.platform, postedAt: schema.taskLinks.postedAt }).from(schema.taskLinks).where(inArray(schema.taskLinks.taskId, ids)).orderBy(asc(schema.taskLinks.postedAt))
  const platforms = new Map<string, Set<string>>()
  const firstPost = new Map<string, Date>()
  for (const l of links) {
    if (l.platform) platforms.set(l.taskId, (platforms.get(l.taskId) ?? new Set()).add(l.platform))
    if (!firstPost.has(l.taskId)) firstPost.set(l.taskId, l.postedAt)
  }
  const drafts = await db.select({ taskId: schema.drafts.taskId, kind: schema.drafts.kind, media: schema.drafts.media, status: schema.drafts.status, version: schema.drafts.version }).from(schema.drafts).where(inArray(schema.drafts.taskId, ids))
  const draftOf = new Map<string, typeof drafts[number]>()
  for (const d of drafts) {
    const cur = draftOf.get(d.taskId)
    const rank = (x: typeof d) => (x.status === 'freigegeben' ? 1000 : 0) + x.version
    if (!cur || rank(d) > rank(cur)) draftOf.set(d.taskId, d)
  }
  const codes = tasks.map(t => t.code.toLowerCase())
  const utm = await db.select({
    campaign: schema.utmStats.campaign,
    visits: sql<number>`sum(${schema.utmStats.visits})::int`,
    signups: sql<number>`sum(${schema.utmStats.signups})::int`,
    purchases: sql<number>`sum(${schema.utmStats.purchases})::int`,
  }).from(schema.utmStats).where(and(eq(schema.utmStats.projectId, projectId), gte(schema.utmStats.day, from))).groupBy(schema.utmStats.campaign)
  const utmOf = new Map<string, { visits: number, signups: number, purchases: number }>()
  for (const u of utm) {
    const code = codes.find(c => u.campaign === c || u.campaign.endsWith(`-${c}`))
    if (!code) continue
    const cur = utmOf.get(code) ?? { visits: 0, signups: 0, purchases: 0 }
    utmOf.set(code, { visits: cur.visits + u.visits, signups: cur.signups + u.signups, purchases: cur.purchases + u.purchases })
  }
  return tasks.map((t) => {
    const m = metrics.get(t.id) ?? {}
    const hasUtm = utmOf.has(t.code.toLowerCase())
    const ut = utmOf.get(t.code.toLowerCase()) ?? { visits: 0, signups: 0, purchases: 0 }
    const d = draftOf.get(t.id)
    const posted = firstPost.get(t.id)
    const time = t.dueTime ?? (posted ? timeIn(ws.timezone, posted) : null)
    return {
      taskId: t.id,
      code: t.code,
      dueDate: t.dueDate ?? (posted ? todayIn(ws.timezone, posted) : from),
      channelKey: t.strategyChannel ?? t.category,
      category: t.category,
      platforms: [...(platforms.get(t.id) ?? [])],
      format: formatOf(d?.kind ?? t.draftKind, (d?.media ?? []).map(x => x.mime)),
      bucket: t.category === 'social' ? timeBucket(time) : null,
      arm: t.experimentArm ?? null,
      experimentId: t.experimentId ?? null,
      measured: Object.keys(m).length > 0 || hasUtm,
      reach: m.reach ?? m.views ?? 0,
      interactions: (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0),
      clicks: m.clicks ?? 0,
      visits: ut.visits,
      signups: ut.signups,
      purchases: ut.purchases,
    }
  })
}

export function metricValue(f: Pick<PostFact, 'reach' | 'interactions' | 'clicks' | 'visits' | 'signups'>, metric: ExperimentMetric): number {
  switch (metric) {
    case 'reichweite': return f.reach
    case 'klicks': return f.clicks
    case 'besuche': return f.visits
    case 'anmeldungen': return f.signups
    default: return f.interactions
  }
}

// Strategie-Verlauf: Kennzahlen je Woche und Version

export function versionAt(strategies: Pick<StrategyRow, 'id' | 'version' | 'decidedAt' | 'createdAt'>[], date: string): { id: string, version: number } | null {
  const sorted = [...strategies].sort((a, b) => (a.decidedAt ?? a.createdAt).getTime() - (b.decidedAt ?? b.createdAt).getTime())
  let hit = sorted[0] ?? null
  for (const s of sorted) if ((s.decidedAt ?? s.createdAt).toISOString().slice(0, 10) <= date) hit = s
  return hit ? { id: hit.id, version: hit.version } : null
}

interface WeekRow {
  strategyId: string | null
  version: number
  dimension: StrategyWeekDimension
  key: string
  posts: number
  measured: number
  reach: number
  interactions: number
  clicks: number
  visits: number
  signups: number
  purchases: number
  costEur: number
}

export function weekRows(facts: PostFact[], strategies: Pick<StrategyRow, 'id' | 'version' | 'decidedAt' | 'createdAt'>[], weekEnd: string, costEur: number): WeekRow[] {
  const rows = new Map<string, WeekRow>()
  const add = (v: { id: string, version: number } | null, dimension: StrategyWeekDimension, key: string, f: PostFact | null) => {
    const id = `${v?.version ?? 0}|${dimension}|${key}`
    let r = rows.get(id)
    if (!r) rows.set(id, r = { strategyId: v?.id ?? null, version: v?.version ?? 0, dimension, key, posts: 0, measured: 0, reach: 0, interactions: 0, clicks: 0, visits: 0, signups: 0, purchases: 0, costEur: 0 })
    if (!f) return r
    r.posts++
    if (f.measured) r.measured++
    r.reach += f.reach
    r.interactions += f.interactions
    r.clicks += f.clicks
    r.visits += f.visits
    r.signups += f.signups
    r.purchases += f.purchases
    return r
  }
  for (const f of facts) {
    const v = versionAt(strategies, f.dueDate)
    add(v, 'gesamt', '', f)
    add(v, 'kanal', f.channelKey, f)
    for (const p of f.platforms) add(v, 'plattform', p, f)
    add(v, 'format', f.format, f)
    if (f.bucket) add(v, 'uhrzeit', f.bucket, f)
  }
  if (costEur > 0) add(versionAt(strategies, weekEnd), 'gesamt', '', null).costEur = Math.round(costEur * 1e6) / 1e6
  return [...rows.values()]
}

export async function recordWeek(db: Db, ws: Pick<Workspace, 'id' | 'timezone'>, project: Pick<Project, 'id'>, week: string): Promise<number> {
  const end = addDays(week, 6)
  const strategies = await db.select().from(schema.strategies).where(and(eq(schema.strategies.projectId, project.id), inArray(schema.strategies.status, ['aktiv', 'abgeloest'])))
  const facts = await postFacts(db, ws, project.id, week, end)
  const [cost] = await db.select({ eur: sql<number>`coalesce(sum(${schema.agentRuns.costEur}), 0)::float` }).from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.workspaceId, ws.id), eq(schema.agentRuns.projectId, project.id), sql`(${schema.agentRuns.startedAt} at time zone ${ws.timezone})::date between ${week} and ${end}`))
  const rows = weekRows(facts, strategies, end, Number(cost?.eur ?? 0))
  await db.transaction(async (tx) => {
    await tx.delete(schema.strategyWeeks).where(and(eq(schema.strategyWeeks.projectId, project.id), eq(schema.strategyWeeks.week, week)))
    if (rows.length) await tx.insert(schema.strategyWeeks).values(rows.map(r => ({ ...r, workspaceId: ws.id, projectId: project.id, week, updatedAt: now() })))
  })
  return rows.length
}

// Zeichnet die letzte abgeschlossene Woche auf und frischt bis zu drei schon aufgezeichnete Vorwochen auf (Zahlen kommen verspätet).
export async function recordWeeks(db: Db, ws: Pick<Workspace, 'id' | 'timezone'>, project: Pick<Project, 'id'>, today: string): Promise<number> {
  const last = addDays(startOfWeek(today), -7)
  const known = await db.selectDistinct({ week: schema.strategyWeeks.week }).from(schema.strategyWeeks)
    .where(and(eq(schema.strategyWeeks.projectId, project.id), gte(schema.strategyWeeks.week, addDays(last, -21)), lte(schema.strategyWeeks.week, addDays(last, -7))))
  let n = 0
  for (const w of [...known.map(k => k.week), last]) n += await recordWeek(db, ws, project, w)
  return n
}

export async function strategyWeeks(db: DbOrTx, projectId: string, weeks = 8, dimension: StrategyWeekDimension = 'gesamt') {
  return db.select().from(schema.strategyWeeks).where(and(eq(schema.strategyWeeks.projectId, projectId), eq(schema.strategyWeeks.dimension, dimension))).orderBy(desc(schema.strategyWeeks.week), asc(schema.strategyWeeks.key)).limit(weeks * (dimension === 'gesamt' ? 2 : 12))
}

// Bewertung

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function round(n: number, d = 2): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

export function evaluateArms(a: number[], b: number[], min = MIN_PER_ARM, threshold = THRESHOLD, at = now()): ExperimentResult {
  const ma = mean(a)
  const mb = mean(b)
  const base = { a: { posts: a.length, mean: round(ma) }, b: { posts: b.length, mean: round(mb) }, at: at.toISOString() }
  if (a.length < min || b.length < min) return { ...base, diff: null, verdict: 'zu_wenig' }
  if (ma === 0 && mb === 0) return { ...base, diff: 0, verdict: 'gleich' }
  const diff = ma === 0 ? 1 : (mb - ma) / ma
  return { ...base, diff: round(diff, 3), verdict: diff >= threshold ? 'besser' : diff <= -threshold ? 'schlechter' : 'gleich' }
}

async function armSamples(db: Db, ws: Workspace, exp: ExperimentRow, today: string): Promise<{ a: number[], b: number[], min: number }> {
  const start = exp.startDate ?? today
  const end = exp.endDate ?? today
  const settled = addDays(today, -SETTLE_DAYS)
  const last = end < settled ? end : settled
  if (exp.variable === 'takt') {
    const weekly = async (from: string) => {
      const facts = (await postFacts(db, ws, exp.projectId, from, addDays(from, 6))).filter(f => f.channelKey === exp.channelKey)
      return facts.reduce((s, f) => s + metricValue(f, exp.metric), 0)
    }
    const first = startOfWeek(start) === start ? start : addDays(startOfWeek(start), 7)
    const b: number[] = []
    for (let w = first; addDays(w, 6) <= last; w = addDays(w, 7)) b.push(await weekly(w))
    const a = [await weekly(addDays(startOfWeek(start), -14)), await weekly(addDays(startOfWeek(start), -7))]
    return { a, b, min: 2 }
  }
  if (exp.variable === 'kanal') {
    const facts = (await postFacts(db, ws, exp.projectId, start, last)).filter(f => f.measured)
    return { a: facts.filter(f => f.channelKey === exp.variantA).map(f => metricValue(f, exp.metric)), b: facts.filter(f => f.channelKey === exp.variantB).map(f => metricValue(f, exp.metric)), min: exp.minPosts }
  }
  const facts = (await postFacts(db, ws, exp.projectId, start, last, { experimentId: exp.id })).filter(f => f.measured)
  return { a: facts.filter(f => f.arm === 'A').map(f => metricValue(f, exp.metric)), b: facts.filter(f => f.arm === 'B').map(f => metricValue(f, exp.metric)), min: exp.minPosts }
}

// Lesen

export async function openExperiment(db: DbOrTx, projectId: string): Promise<ExperimentRow | null> {
  const [e] = await db.select().from(schema.experiments).where(and(eq(schema.experiments.projectId, projectId), inArray(schema.experiments.status, ['vorschlag', 'laeuft']))).limit(1)
  return e ?? null
}

export async function listExperiments(db: DbOrTx, projectId: string, limit = 8): Promise<ExperimentRow[]> {
  return db.select().from(schema.experiments).where(and(eq(schema.experiments.projectId, projectId), ne(schema.experiments.status, 'verworfen'))).orderBy(desc(schema.experiments.createdAt)).limit(limit)
}

export async function listInsights(db: DbOrTx, projectId: string, opts: { all?: boolean, limit?: number } = {}): Promise<InsightRow[]> {
  return db.select().from(schema.insights).where(and(eq(schema.insights.projectId, projectId), opts.all ? undefined : eq(schema.insights.active, true))).orderBy(desc(schema.insights.createdAt)).limit(opts.limit ?? 20)
}

export function variantLabel(variable: ExperimentVariable, x: string): string {
  return variable === 'format' ? FORMAT_LABELS[x] ?? x : variable === 'takt' ? `${WEIGHT_PER_WEEK[Number(x)] ?? x}x pro Woche` : x
}

export function experimentLabel(e: Pick<ExperimentRow, 'variable' | 'variantA' | 'variantB'>): string {
  return `${variantLabel(e.variable, e.variantB)} statt ${variantLabel(e.variable, e.variantA)}`
}

export async function armCounts(db: DbOrTx, experimentId: string): Promise<{ a: number, b: number }> {
  const rows = await db.select({ arm: schema.tasks.experimentArm, n: sql<number>`count(*)::int` }).from(schema.tasks)
    .where(and(eq(schema.tasks.experimentId, experimentId), inArray(schema.tasks.status, DONE_STATUSES))).groupBy(schema.tasks.experimentArm)
  return { a: rows.find(r => r.arm === 'A')?.n ?? 0, b: rows.find(r => r.arm === 'B')?.n ?? 0 }
}

// Kontext für Strategie, Planung, Entwürfe und Release-Kampagnen
export async function insightsDigest(db: DbOrTx, projectId: string, opts: { channelKey?: string | null } = {}): Promise<string> {
  const list = (await listInsights(db, projectId, { limit: 10 })).filter(i => !opts.channelKey || !i.channelKey || i.channelKey === opts.channelKey)
  const open = await openExperiment(db, projectId)
  const lines = [
    ...list.map(i => `- ${i.text}`),
    open?.status === 'laeuft' ? `- Läuft gerade: Experiment ${open.hypothesis} (${experimentLabel(open)}, bis ${open.endDate}). Nicht eigenmächtig ändern.` : '',
  ].filter(Boolean)
  return lines.length ? `Erkenntnisse aus eigenen Experimenten (gemessen, gelten vor Faustregeln):\n${lines.join('\n')}` : ''
}

// Format für einen Entwurf: Variante des laufenden Experiments, sonst das behaltene Format des Kanals.
export async function formatFor(db: DbOrTx, task: Pick<typeof schema.tasks.$inferSelect, 'projectId' | 'strategyChannel' | 'experimentId' | 'experimentArm' | 'category'>): Promise<string | null> {
  if (task.category !== 'social' || !task.projectId) return null
  if (task.experimentId && task.experimentArm) {
    const [e] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, task.experimentId))
    if (e?.variable === 'format') return task.experimentArm === 'B' ? e.variantB : e.variantA
  }
  if (!task.strategyChannel) return null
  const [i] = await db.select({ winner: schema.insights.winner }).from(schema.insights)
    .where(and(eq(schema.insights.projectId, task.projectId), eq(schema.insights.variable, 'format'), eq(schema.insights.channelKey, task.strategyChannel), eq(schema.insights.active, true))).orderBy(desc(schema.insights.createdAt)).limit(1)
  return i?.winner ?? null
}

// Bestzeit aus einem behaltenen Uhrzeit-Experiment (für Release-Kampagnen).
export async function insightTime(db: DbOrTx, projectId: string): Promise<string | null> {
  const [i] = await db.select({ winner: schema.insights.winner }).from(schema.insights)
    .where(and(eq(schema.insights.projectId, projectId), eq(schema.insights.variable, 'uhrzeit'), eq(schema.insights.active, true))).orderBy(desc(schema.insights.createdAt)).limit(1)
  return i?.winner && /^\d{2}:\d{2}$/.test(i.winner) ? i.winner : null
}

// Kanäle, deren Uhrzeit gerade getestet wird oder durch ein Experiment festgelegt ist (Bestzeiten lassen sie in Ruhe).
export async function lockedTimeChannels(db: DbOrTx, projectId: string): Promise<Set<string>> {
  const run = await db.select({ key: schema.experiments.channelKey }).from(schema.experiments).where(and(eq(schema.experiments.projectId, projectId), eq(schema.experiments.variable, 'uhrzeit'), eq(schema.experiments.status, 'laeuft')))
  const kept = await db.select({ key: schema.insights.channelKey }).from(schema.insights).where(and(eq(schema.insights.projectId, projectId), eq(schema.insights.variable, 'uhrzeit'), eq(schema.insights.active, true), sql`${schema.insights.winner} ~ '^[0-9]{2}:[0-9]{2}$'`))
  return new Set([...run, ...kept].map(r => r.key).filter((k): k is string => !!k))
}

// Planung: Aufgaben eines laufenden Experiments abwechselnd auf A und B verteilen

function instruction(e: ExperimentRow): string {
  if (e.variable === 'format') return `${EXPERIMENT_MARK} als ${FORMAT_LABELS[e.variantB] ?? e.variantB} umsetzen${e.variantB === 'text' ? ' (kein Bild, kein Video)' : ''}.`
  if (e.variable === 'thema') return `${EXPERIMENT_MARK} Thema/Winkel "${e.variantB}".`
  return `${EXPERIMENT_MARK} ${e.variantB}.`
}

function stripInstruction(desc: string | null): string | null {
  if (!desc) return desc
  const out = desc.split('\n').filter(l => !l.startsWith(EXPERIMENT_MARK)).join('\n').trimEnd()
  return out || null
}

export async function assignExperimentTasks(db: DbOrTx, exp: ExperimentRow, today: string): Promise<number> {
  if (exp.status !== 'laeuft' || !SMALL_VARIABLES.includes(exp.variable) || !exp.channelKey || !exp.startDate || !exp.endDate) return 0
  const from = exp.startDate > today ? exp.startDate : today
  const free = await db.select({ id: schema.tasks.id, description: schema.tasks.description }).from(schema.tasks).where(and(
    eq(schema.tasks.projectId, exp.projectId),
    eq(schema.tasks.strategyChannel, exp.channelKey),
    eq(schema.tasks.status, 'geplant'),
    eq(schema.tasks.skippedByPlan, false),
    isNull(schema.tasks.experimentId),
    gte(schema.tasks.dueDate, from),
    lte(schema.tasks.dueDate, exp.endDate),
    sql`not exists (select 1 from drafts where drafts.task_id = ${schema.tasks.id})`,
  )).orderBy(asc(schema.tasks.dueDate), asc(schema.tasks.dueTime))
  if (!free.length) return 0
  const counts = await db.select({ arm: schema.tasks.experimentArm, n: sql<number>`count(*)::int` }).from(schema.tasks).where(eq(schema.tasks.experimentId, exp.id)).groupBy(schema.tasks.experimentArm)
  let a = counts.find(c => c.arm === 'A')?.n ?? 0
  let b = counts.find(c => c.arm === 'B')?.n ?? 0
  for (const t of free) {
    const arm: 'A' | 'B' = b < a ? 'B' : 'A'
    if (arm === 'A') a++
    else b++
    const set: Partial<typeof schema.tasks.$inferInsert> = { experimentId: exp.id, experimentArm: arm, updatedAt: now() }
    if (exp.variable === 'uhrzeit') set.dueTime = arm === 'B' ? exp.variantB : exp.variantA
    else if (arm === 'B') set.description = [stripInstruction(t.description), instruction(exp)].filter(Boolean).join('\n\n')
    await db.update(schema.tasks).set(set).where(eq(schema.tasks.id, t.id))
  }
  return free.length
}

// Offene, noch nicht entworfene Aufgaben zurück auf A (beim Verwerfen oder Abbrechen).
async function releaseTasks(db: DbOrTx, exp: ExperimentRow, today: string, toArm: 'A' | 'B'): Promise<void> {
  const open = await db.select({ id: schema.tasks.id, description: schema.tasks.description, arm: schema.tasks.experimentArm }).from(schema.tasks).where(and(
    eq(schema.tasks.experimentId, exp.id),
    eq(schema.tasks.status, 'geplant'),
    gte(schema.tasks.dueDate, today),
    sql`not exists (select 1 from drafts where drafts.task_id = ${schema.tasks.id})`,
  ))
  for (const t of open) {
    const set: Partial<typeof schema.tasks.$inferInsert> = { experimentId: null, experimentArm: null, description: stripInstruction(t.description), updatedAt: now() }
    if (exp.variable === 'uhrzeit') set.dueTime = toArm === 'B' ? exp.variantB : exp.variantA
    await db.update(schema.tasks).set(set).where(eq(schema.tasks.id, t.id))
  }
}

// Start, Abbruch, Auswertung

export function smallExperiment(variable: ExperimentVariable): boolean {
  return SMALL_VARIABLES.includes(variable)
}

export function agentMayStart(project: Pick<Project, 'autonomy'>): boolean {
  return effectiveAutonomy(project.autonomy ?? {}, 'social', 'post').level !== 'approve'
}

export async function startExperiment(db: Db, project: Project, exp: ExperimentRow, today: string, by: { userId?: string | null, agent: boolean }): Promise<ExperimentRow> {
  const start = addDays(today, 1)
  const [row] = await db.update(schema.experiments).set({ status: 'laeuft', startDate: start, endDate: addDays(start, RUN_DAYS - 1), decidedByUserId: by.userId ?? null })
    .where(and(eq(schema.experiments.id, exp.id), eq(schema.experiments.status, 'vorschlag'))).returning()
  if (!row) return exp
  await assignExperimentTasks(db, row, today)
  await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: by.agent ? 'agent' : 'user', userId: by.userId ?? null, action: 'experiment_started', detail: { title: row.hypothesis, text: experimentLabel(row) }, at: now() })
  return row
}

export async function rejectExperiment(db: Db, project: Project, exp: ExperimentRow, userId: string | null): Promise<void> {
  await db.update(schema.experiments).set({ status: 'verworfen', decidedAt: now(), decidedByUserId: userId }).where(eq(schema.experiments.id, exp.id))
  if (exp.strategyId) {
    const [st] = await db.select().from(schema.strategies).where(eq(schema.strategies.id, exp.strategyId))
    if (st?.status === 'vorschlag') await db.update(schema.strategies).set({ status: 'verworfen', decidedAt: now(), decidedByUserId: userId }).where(eq(schema.strategies.id, st.id))
  }
  await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: userId ? 'user' : 'agent', userId, action: 'experiment_rejected', detail: { title: exp.hypothesis }, at: now() })
}

export async function stopExperiment(db: Db, project: Project, exp: ExperimentRow, today: string, userId: string | null): Promise<void> {
  await releaseTasks(db, exp, today, 'A')
  if (exp.variable === 'takt') await revertTakt(db, project, exp, today)
  await db.update(schema.experiments).set({ status: 'abgebrochen', decision: 'verwerfen', decidedAt: now(), decidedByUserId: userId }).where(eq(schema.experiments.id, exp.id))
  await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: userId ? 'user' : 'agent', userId, action: 'experiment_stopped', detail: { title: exp.hypothesis }, at: now() })
}

async function revertTakt(db: Db, project: Project, exp: ExperimentRow, today: string): Promise<void> {
  const cur = await activeStrategy(db, project.id)
  const c = cur?.channels.find(x => x.key === exp.channelKey)
  const to = Number(exp.variantA)
  if (!c || !Number.isFinite(to) || c.weight === to) return
  await changeStrategy(db, project, [{ channelKey: c.key, name: c.name, change: to < c.weight ? 'less' : 'more', from: c.weight, to, reason: `Experiment beendet, zurück zum Takt vorher: ${exp.hypothesis}`.slice(0, 200) }], today, { kind: 'review', byAgent: true })
}

async function keepTime(db: Db, project: Project, exp: ExperimentRow, today: string): Promise<void> {
  const cur = await activeStrategy(db, project.id)
  if (!cur) return
  const channels = cur.channels.map(c => (c.key === exp.channelKey ? { ...c, time: exp.variantB } : c))
  await db.update(schema.strategies).set({ channels }).where(eq(schema.strategies.id, cur.id))
  await releaseTasks(db, exp, today, 'B')
  await applyStrategy(db, project, { ...cur, channels }, today)
}

function verdictText(r: ExperimentResult): string {
  if (r.verdict === 'zu_wenig') return 'zu wenig Daten'
  if (r.verdict === 'gleich') return 'kein klarer Unterschied'
  return r.verdict
}

export function insightText(e: Pick<ExperimentRow, 'variable' | 'variantA' | 'variantB' | 'metric'>, channelName: string, r: ExperimentResult): string {
  const label = (x: string) => variantLabel(e.variable, x)
  const per = e.variable === 'takt' ? 'pro Woche' : 'je Beitrag'
  const pct = r.diff === null ? '' : `${r.diff >= 0 ? '+' : ''}${Math.round(r.diff * 100)} %`
  const counts = e.variable === 'takt' ? `${r.a.posts} vs ${r.b.posts} Wochen` : `${r.a.posts} vs ${r.b.posts} Beiträge`
  const head = r.verdict === 'besser' ? `${label(e.variantB)} > ${label(e.variantA)}` : r.verdict === 'schlechter' ? `${label(e.variantA)} > ${label(e.variantB)}` : `${label(e.variantB)} ~ ${label(e.variantA)}`
  return `${channelName}: ${head}, ${pct} ${METRIC_LABELS[e.metric]} ${per} (${counts})`.replace(/ {2,}/g, ' ')
}

export async function decideExperiment(db: Db, ws: Workspace, project: Project, exp: ExperimentRow, today: string): Promise<string | null> {
  if (exp.status !== 'laeuft' || !exp.endDate || today <= exp.endDate) return null
  const s = await armSamples(db, ws, exp, today)
  const r = evaluateArms(s.a, s.b, s.min)
  if (r.verdict === 'zu_wenig' && exp.extensions < MAX_EXTENSIONS) {
    const end = addDays(exp.endDate, EXTEND_DAYS)
    const [row] = await db.update(schema.experiments).set({ endDate: end, extensions: exp.extensions + 1, decision: 'verlaengern', result: r }).where(eq(schema.experiments.id, exp.id)).returning()
    await assignExperimentTasks(db, row!, today)
    await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'experiment_extended', detail: { title: exp.hypothesis, text: `zu wenig Daten (A ${r.a.posts}, B ${r.b.posts}), verlängert bis ${end}` }, at: now() })
    return `Experiment verlängert bis ${end}: zu wenig Daten (A ${r.a.posts}, B ${r.b.posts} gemessene ${exp.variable === 'takt' ? 'Wochen' : 'Beiträge'}).`
  }
  const keep = r.verdict === 'besser'
  const strat = await activeStrategy(db, project.id)
  const channelName = strat?.channels.find(c => c.key === exp.channelKey)?.name ?? exp.channelKey ?? project.name
  if (keep) {
    if (exp.variable === 'uhrzeit') await keepTime(db, project, exp, today)
    else await releaseTasks(db, exp, today, 'B')
  }
  else {
    await releaseTasks(db, exp, today, 'A')
    if (exp.variable === 'takt') await revertTakt(db, project, exp, today)
  }
  await db.update(schema.experiments).set({ status: r.verdict === 'zu_wenig' ? 'abgebrochen' : 'ausgewertet', decision: keep ? 'behalten' : 'verwerfen', result: r, decidedAt: now() }).where(eq(schema.experiments.id, exp.id))
  let text: string
  if (r.verdict === 'zu_wenig') text = `Experiment beendet, zu wenig Daten (A ${r.a.posts}, B ${r.b.posts}): zurück zu ${variantLabel(exp.variable, exp.variantA)}.`
  else {
    const t = insightText(exp, channelName, r)
    await db.update(schema.insights).set({ active: false }).where(and(eq(schema.insights.projectId, project.id), eq(schema.insights.variable, exp.variable), exp.channelKey ? eq(schema.insights.channelKey, exp.channelKey) : isNull(schema.insights.channelKey)))
    await db.insert(schema.insights).values({ workspaceId: ws.id, projectId: project.id, experimentId: exp.id, variable: exp.variable, channelKey: exp.channelKey, winner: keep ? exp.variantB : exp.variantA, loser: keep ? exp.variantA : exp.variantB, diff: r.diff, text: t, createdAt: now() })
    text = `Experiment ausgewertet (${verdictText(r)}): ${t}. ${keep ? 'Variante B übernommen.' : 'Zurück zu A.'}`
  }
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'experiment_decided', detail: { title: exp.hypothesis, text, verdict: r.verdict }, at: now() })
  return text
}

// Maßnahmen mit Vorher/Nachher: erledigte Content-/SEO-Aufgaben mit eigener Seite, Search Console 4 Wochen vor vs. nach Umsetzung.
export const ACTION_DAYS = 28
export const ACTION_MIN_IMPRESSIONS = 50

export interface PageWindow { clicks: number, impressions: number, position: number | null }

export function compareWindows(before: PageWindow, after: PageWindow, threshold = THRESHOLD): { verdict: 'besser' | 'schlechter' | 'gleich' | 'zu_wenig', diff: number | null } {
  if (before.impressions + after.impressions < ACTION_MIN_IMPRESSIONS) return { verdict: 'zu_wenig', diff: null }
  const diff = before.clicks === 0 ? (after.clicks > 0 ? 1 : 0) : (after.clicks - before.clicks) / before.clicks
  return { verdict: diff >= threshold ? 'besser' : diff <= -threshold ? 'schlechter' : 'gleich', diff: round(diff, 3) }
}

async function pageWindow(db: DbOrTx, projectId: string, page: string, from: string, to: string): Promise<PageWindow> {
  const [r] = await db.select({
    clicks: sql<number>`coalesce(sum(${schema.searchStats.clicks}), 0)::int`,
    impressions: sql<number>`coalesce(sum(${schema.searchStats.impressions}), 0)::int`,
    wp: sql<number>`coalesce(sum(${schema.searchStats.position} * ${schema.searchStats.impressions}), 0)::float`,
  }).from(schema.searchStats).where(and(eq(schema.searchStats.projectId, projectId), eq(schema.searchStats.source, 'google'), eq(schema.searchStats.query, ''), sql`rtrim(${schema.searchStats.page}, '/') = rtrim(${page}, '/')`, gte(schema.searchStats.day, from), lte(schema.searchStats.day, to)))
  const impressions = r?.impressions ?? 0
  return { clicks: r?.clicks ?? 0, impressions, position: impressions ? round(Number(r!.wp) / impressions, 1) : null }
}

export async function measureActions(db: Db, ws: Workspace, project: Project, today: string): Promise<string[]> {
  const cutoff = addDays(today, -ACTION_DAYS - 3)
  const rows = await db.select({ id: schema.tasks.id, title: schema.tasks.title, postedUrl: schema.tasks.postedUrl, targetUrl: schema.tasks.targetUrl, doneAt: schema.tasks.doneAt, dueDate: schema.tasks.dueDate }).from(schema.tasks).where(and(
    eq(schema.tasks.projectId, project.id),
    inArray(schema.tasks.category, ['content', 'verzeichnis', 'pflege']),
    inArray(schema.tasks.status, DONE_STATUSES),
    gte(schema.tasks.dueDate, addDays(today, -120)),
    lte(schema.tasks.dueDate, cutoff),
    sql`not exists (select 1 from insights i where i.project_id = ${project.id} and i.variable = 'massnahme' and i.channel_key = 'task:' || ${schema.tasks.id}::text)`,
  )).limit(20)
  const lines: string[] = []
  const host = siteHost(project.url)
  for (const t of rows) {
    const page = [t.postedUrl, t.targetUrl].find(u => !!u && (!host || siteHost(u) === host))
    if (!page) continue
    const day = t.doneAt ? t.doneAt.toISOString().slice(0, 10) : t.dueDate!
    if (addDays(day, ACTION_DAYS + 2) > today) continue
    const before = await pageWindow(db, project.id, page, addDays(day, -ACTION_DAYS), addDays(day, -1))
    const after = await pageWindow(db, project.id, page, addDays(day, 2), addDays(day, ACTION_DAYS + 1))
    const r = compareWindows(before, after)
    if (r.verdict === 'zu_wenig') continue
    const pct = `${r.diff! >= 0 ? '+' : ''}${Math.round(r.diff! * 100)} %`
    const pos = before.position && after.position ? `, Position ${before.position} -> ${after.position}` : ''
    const text = `Maßnahme "${t.title.slice(0, 80)}": ${pct} Google-Klicks (${before.clicks} -> ${after.clicks} in 4 Wochen${pos})`
    await db.insert(schema.insights).values({ workspaceId: ws.id, projectId: project.id, variable: 'massnahme', channelKey: `task:${t.id}`, winner: r.verdict, diff: r.diff, text, active: r.verdict !== 'gleich', createdAt: now() })
    lines.push(text)
  }
  return lines
}

// Vorschlag: höchstens ein Experiment je Projekt gleichzeitig

interface Candidate {
  variable: ExperimentVariable
  channelKey: string
  variantA: string
  variantB: string
  hypothesis: string
  metric: ExperimentMetric
}

async function testedPairs(db: DbOrTx, projectId: string, today: string): Promise<{ done: Set<string>, last: Map<ExperimentVariable, string>, retry: ExperimentVariable | null }> {
  const rows = await db.select().from(schema.experiments).where(and(eq(schema.experiments.projectId, projectId), gte(schema.experiments.createdAt, new Date(`${addDays(today, -180)}T00:00:00Z`)))).orderBy(desc(schema.experiments.createdAt))
  const done = new Set<string>()
  const last = new Map<ExperimentVariable, string>()
  const recent = rows.find(r => r.status === 'ausgewertet' || r.status === 'abgebrochen')
  const retry = recent && recent.decision === 'verwerfen' ? recent.variable : null
  for (const r of rows) {
    if (!last.has(r.variable)) last.set(r.variable, r.createdAt.toISOString())
    if (r.status === 'verworfen' && diffDays(today, r.createdAt.toISOString().slice(0, 10)) > 42) continue
    done.add(`${r.channelKey}|${r.variable}|${r.variantA}|${r.variantB}`)
  }
  return { done, last, retry }
}

export async function candidates(db: Db, ws: Workspace, project: Project, strat: StrategyRow, today: string): Promise<Candidate[]> {
  const facts = await postFacts(db, ws, project.id, addDays(today, -28), today)
  const social = strat.channels.filter(c => c.active && c.category === 'social')
  const ranked = social.map(c => ({ c, facts: facts.filter(f => f.channelKey === c.key && f.measured) })).filter(x => x.facts.length >= MIN_PER_ARM).sort((a, b) => b.facts.length - a.facts.length)
  if (!ranked.length) return []
  const { done, last, retry } = await testedPairs(db, project.id, today)
  const postable = socialTarget(ws, project)?.platforms.filter(p => p.postable).map(p => p.platform) ?? []
  const videos = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.mediaLibrary).where(and(eq(schema.mediaLibrary.projectId, project.id), sql`${schema.mediaLibrary.mime} like 'video/%'`)))[0]?.n ?? 0
  const out: Candidate[] = []
  for (const { c, facts: own } of ranked) {
    const fresh = (variable: ExperimentVariable, a: string, b: string) => !done.has(`${c.key}|${variable}|${a}|${b}`)
    const timeA = c.time ?? '10:00'
    const timeB = TIME_VARIANTS.find(t => Math.abs(minutesOf(t) - minutesOf(timeA)) >= 120 && fresh('uhrzeit', timeA, t))
    if (timeB) out.push({ variable: 'uhrzeit', channelKey: c.key, variantA: timeA, variantB: timeB, metric: 'interaktionen', hypothesis: `${c.name}: Posts um ${timeB} bringen mehr Interaktionen je Beitrag als um ${timeA}` })
    const counts = new Map<string, number>()
    for (const f of own) counts.set(f.format, (counts.get(f.format) ?? 0) + 1)
    const fmtA = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'text'
    const fmtB = FORMAT_VARIANTS.find(f => f !== fmtA && (FORMAT_VARIANTS as readonly string[]).includes(fmtA) && fresh('format', fmtA, f) && (f !== 'text' || !postable.some(p => MEDIA_REQUIRED.includes(p))) && (f !== 'video' || videos >= 2))
    if (fmtB) out.push({ variable: 'format', channelKey: c.key, variantA: fmtA, variantB: fmtB, metric: 'interaktionen', hypothesis: `${c.name}: ${FORMAT_LABELS[fmtB]} bringt mehr Interaktionen je Beitrag als ${FORMAT_LABELS[fmtA]}` })
    if (c.weight < MAX_WEIGHT && fresh('takt', String(c.weight), String(c.weight + 1))) out.push({ variable: 'takt', channelKey: c.key, variantA: String(c.weight), variantB: String(c.weight + 1), metric: 'interaktionen', hypothesis: `${c.name}: ${WEIGHT_PER_WEEK[c.weight + 1]}x statt ${WEIGHT_PER_WEEK[c.weight]}x pro Woche bringt mehr Interaktionen pro Woche` })
    if (out.length) break
  }
  // Nach einer verworfenen Variante zuerst die nächste Variante derselben Größe, sonst die am längsten nicht getestete Größe.
  const age = (v: ExperimentVariable) => (v === retry ? '' : last.get(v) ?? '')
  return out.sort((a, b) => age(a.variable).localeCompare(age(b.variable)) || (a.variable === retry ? -1 : b.variable === retry ? 1 : 0))
}

export async function proposeExperiment(db: Db, ws: Workspace, project: Project, today: string): Promise<{ experiment: ExperimentRow, started: boolean } | null> {
  if (ws.settings?.agentEnabled === false || ws.pausedAt) return null
  if (await openExperiment(db, project.id)) return null
  const strat = await activeStrategy(db, project.id)
  if (!strat) return null
  const list = await candidates(db, ws, project, strat, today)
  const pending = await pendingProposal(db, project.id)
  const pick = list.find(c => smallExperiment(c.variable) || !pending)
  if (!pick) return null
  let strategyId: string | null = null
  if (!smallExperiment(pick.variable)) {
    const c = strat.channels.find(x => x.key === pick.channelKey)!
    const to = Number(pick.variantB)
    const change = { channelKey: c.key, name: c.name, change: 'more' as const, from: c.weight, to, reason: `Experiment: ${pick.hypothesis}`.slice(0, 200) }
    const channels = strat.channels.map(x => (x.key === c.key ? { ...x, weight: to, active: true } : x))
    const st = await createStrategyVersion(db, project, { channels, changes: [change], summary: `Experiment vorgeschlagen: ${pick.hypothesis}. Gemessen wird ${RUN_DAYS / 7} Wochen gegen den bisherigen Takt; ist es schlechter, geht der Agent zurück.`, status: 'vorschlag', kind: 'review', byAgent: true })
    strategyId = st.id
  }
  const inserted = await db.insert(schema.experiments).values({ workspaceId: ws.id, projectId: project.id, status: 'vorschlag', hypothesis: pick.hypothesis.replace(/[–—]/g, '-'), variable: pick.variable, channelKey: pick.channelKey, variantA: pick.variantA, variantB: pick.variantB, metric: pick.metric, minPosts: MIN_PER_ARM, strategyId, byAgent: true, createdAt: now() }).onConflictDoNothing().returning()
  const exp = inserted[0]
  if (!exp) return null
  if (smallExperiment(exp.variable) && agentMayStart(project)) return { experiment: await startExperiment(db, project, exp, today, { agent: true }), started: true }
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'experiment_proposed', detail: { title: exp.hypothesis, text: experimentLabel(exp) }, at: now() })
  return { experiment: exp, started: false }
}

// Vorschläge, die an einer Strategie-Freigabe hängen, mit deren Entscheidung abgleichen.
export async function syncStrategyExperiments(db: Db, project: Project): Promise<void> {
  const rows = await db.select({ e: schema.experiments, st: schema.strategies }).from(schema.experiments)
    .innerJoin(schema.strategies, eq(schema.strategies.id, schema.experiments.strategyId))
    .where(and(eq(schema.experiments.projectId, project.id), eq(schema.experiments.status, 'vorschlag')))
  for (const { e, st } of rows) {
    if (st.status === 'verworfen') await db.update(schema.experiments).set({ status: 'verworfen', decidedAt: now() }).where(eq(schema.experiments.id, e.id))
    else if (st.status === 'aktiv' || st.status === 'abgeloest') {
      const start = (st.decidedAt ?? now()).toISOString().slice(0, 10)
      await db.update(schema.experiments).set({ status: 'laeuft', startDate: start, endDate: addDays(start, RUN_DAYS - 1), decidedByUserId: st.decidedByUserId }).where(eq(schema.experiments.id, e.id))
    }
  }
}

// Wöchentlicher Schritt im Strategie-Check: auswerten, ggf. nächstes Experiment, Aufgaben verteilen. Ohne KI-Aufrufe.
export async function experimentStep(db: Db, ws: Workspace, project: Project, today: string): Promise<string[]> {
  const lines: string[] = []
  await syncStrategyExperiments(db, project)
  let open = await openExperiment(db, project.id)
  if (open?.status === 'laeuft') {
    const line = await decideExperiment(db, ws, project, open, today)
    if (line) lines.push(line)
    open = await openExperiment(db, project.id)
  }
  if (!open) {
    const p = await proposeExperiment(db, ws, project, today)
    if (p) lines.push(p.started ? `Experiment gestartet: ${p.experiment.hypothesis} (${experimentLabel(p.experiment)}, bis ${p.experiment.endDate}).` : `Experiment vorgeschlagen (Freigabe nötig): ${p.experiment.hypothesis}.`)
    open = p?.experiment ?? null
  }
  if (open?.status === 'laeuft' && ws.settings?.agentEnabled !== false) await assignExperimentTasks(db, open, today)
  const actions = await measureActions(db, ws, project, today)
  if (actions.length) lines.push(`Gemessen: ${actions.join('; ')}.`)
  return lines
}

export async function assignAllRunning(db: Db, ws: Workspace, today: string): Promise<number> {
  if (ws.settings?.agentEnabled === false) return 0
  const rows = await db.select().from(schema.experiments).where(and(eq(schema.experiments.workspaceId, ws.id), eq(schema.experiments.status, 'laeuft')))
  let n = 0
  for (const e of rows) n += await assignExperimentTasks(db, e, today)
  return n
}

// Zeilen für Briefing und Wochenbericht
export async function experimentNews(db: DbOrTx, workspaceId: string, since: Date, opts: { running?: boolean } = {}): Promise<string[]> {
  const rows = await db.select({ e: schema.experiments, name: schema.projects.name }).from(schema.experiments)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.experiments.projectId))
    .where(and(eq(schema.experiments.workspaceId, workspaceId), isNull(schema.projects.archivedAt), ne(schema.experiments.status, 'verworfen')))
    .orderBy(desc(schema.experiments.createdAt)).limit(50)
  const sinceDay = since.toISOString().slice(0, 10)
  const out: string[] = []
  for (const { e, name } of rows) {
    if (e.status === 'laeuft' && (opts.running || (e.startDate ?? '') >= sinceDay)) {
      const c = await armCounts(db, e.id)
      out.push(`${name}: Experiment läuft bis ${e.endDate}: ${e.hypothesis} (bisher A ${c.a}, B ${c.b} Beiträge)`)
    }
    else if (e.status === 'vorschlag' && e.createdAt >= since) out.push(`${name}: Experiment wartet auf Freigabe: ${e.hypothesis}`)
    else if ((e.status === 'ausgewertet' || e.status === 'abgebrochen') && e.decidedAt && e.decidedAt >= since) {
      const [i] = await db.select({ text: schema.insights.text }).from(schema.insights).where(eq(schema.insights.experimentId, e.id)).limit(1)
      out.push(`${name}: Experiment ${e.decision === 'behalten' ? 'erfolgreich, übernommen' : e.result?.verdict === 'zu_wenig' ? 'ohne genug Daten beendet' : 'beendet, zurück zu A'}${i ? `: ${i.text}` : `: ${e.hypothesis}`}`)
    }
  }
  return out
}

// Ansicht für Oberfläche und MCP
export async function experimentsView(db: DbOrTx, projectId: string) {
  const open = await openExperiment(db, projectId)
  const recent = (await listExperiments(db, projectId, 6)).filter(e => e.id !== open?.id && e.status !== 'vorschlag' && e.status !== 'laeuft').slice(0, 5)
  const view = async (e: ExperimentRow) => ({
    id: e.id,
    status: e.status,
    variable: e.variable,
    hypothesis: e.hypothesis,
    label: experimentLabel(e),
    channelKey: e.channelKey,
    variantA: variantLabel(e.variable, e.variantA),
    variantB: variantLabel(e.variable, e.variantB),
    metric: e.metric,
    startDate: e.startDate,
    endDate: e.endDate,
    extensions: e.extensions,
    viaStrategy: !!e.strategyId,
    strategyId: e.strategyId,
    result: e.result ?? null,
    decision: e.decision ?? null,
    counts: await armCounts(db, e.id),
    decidedAt: e.decidedAt?.toISOString() ?? null,
  })
  return {
    current: open ? await view(open) : null,
    recent: await Promise.all(recent.map(view)),
    insights: (await listInsights(db, projectId, { limit: 12 })).map(i => ({ id: i.id, variable: i.variable, text: i.text, diff: i.diff, createdAt: i.createdAt.toISOString() })),
  }
}
