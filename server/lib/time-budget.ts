import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import { addDays, weekday } from '../../shared/utils/dates'
import { budgetOf, DROP_AFTER_DAYS, INFO_BUNDLE_MIN, isClaudeTask, type CostKind } from '../../shared/utils/time-budget'
import type { TaskView } from '../../shared/utils/task-state'
import { taskViews } from './task-view'
import { logActivity } from './activity'
import { now } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { approvalsPerDay } from './approval-limit'
import { selfPerDay } from './self-limit'
import { updateTask, type TaskRow } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect

export interface HumanCost {
  kind: CostKind
  min: number
  userId: string | null
}

const PLANNABLE = ['geplant', 'entwurf_fertig', 'freigegeben', 'wartet'] as const
const PRIO_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 }
const REDDIT = /(reddit|(^|[\s/(])r\/)/i
export const PLAN_HORIZON_DAYS = 42

export { workspaceOwner } from './task-view'

// Was eine Aufgabe den Menschen kostet, aus derselben Quelle wie alle Anzeigen (taskViews).
// Automatisch, von Claude erledigt oder geprüft: 0 Minuten, außer der Mensch postet nach Claudes Prüfung selbst. Noch nicht entworfen: was später auf den Menschen zukommt.
export async function humanCosts(db: DbOrTx, ws: Workspace, tasks: TaskRow[]): Promise<Map<string, HumanCost>> {
  const out = new Map<string, HumanCost>()
  const views = await taskViews(db, ws, tasks)
  for (const t of tasks) {
    const v = views.get(t.id)!
    out.set(t.id, costOf(v))
  }
  return out
}

export function costOf(v: TaskView): HumanCost {
  if (v.who === 'you') {
    const kind: CostKind = v.next === 'answer' ? 'info' : v.next === 'approve' || v.next === 'review' ? 'approve' : 'self'
    return { kind, min: v.min, userId: v.userId }
  }
  if (v.who === 'claude') return v.then === 'post' ? { kind: 'self', min: v.min, userId: v.userId } : { kind: 'claude', min: 0, userId: v.userId }
  if (v.who === 'ai' && v.plannedMin > 0) return { kind: v.next === 'aiWrites' ? 'approve' : 'self', min: v.plannedMin, userId: v.userId }
  return { kind: v.who === 'ai' || v.who === 'waiting' ? 'auto' : 'none', min: 0, userId: v.userId }
}

// Minuten einer Liste (alle Info-Rückfragen zusammen einmal).
export function sumMinutes(costs: HumanCost[]): number {
  const info = costs.some(c => c.kind === 'info')
  return costs.reduce((s, c) => s + c.min, 0) + (info ? INFO_BUNDLE_MIN : 0)
}

function workday(d: string): string {
  const w = weekday(d)
  return w === 6 ? addDays(d, 2) : w === 7 ? addDays(d, 1) : d
}

export interface BudgetResult {
  moved: number
  dropped: number
  claude: number
}

// Website-/Code-Aufgaben als "für Claude" markieren (einmalig, auch für ältere Aufgaben).
export async function markClaudeTasks(db: DbOrTx, ws: Pick<Workspace, 'id'>): Promise<number> {
  const rows = await db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, ws.id), inArray(schema.tasks.status, [...PLANNABLE]), eq(schema.tasks.forClaude, false)))
  const hits = rows.filter(isClaudeTask)
  if (hits.length) await db.update(schema.tasks).set({ forClaude: true, updatedAt: now() }).where(inArray(schema.tasks.id, hits.map(t => t.id)))
  return hits.length
}

// Menschenarbeit je Person und Tag aufs Zeitbudget verteilen. Was nicht passt, rückt nach Priorität auf spätere Werktage.
// Geringe Wirkung (P3), die weiter als DROP_AFTER_DAYS hinter ihren ersten Termin rutschen würde, fällt weg (verworfen, mit Grund).
// Fest bleiben: vom Menschen angelegt, Meilenstein, Experiment, Reddit (erlaubte Tage). Sie zählen mit.
// Obergrenzen bleiben: höchstens selfPerDay Selbst-Aufgaben und approvalsPerDay Freigaben je Tag.
export async function planByBudget(db: DbOrTx, ws: Workspace, today: string): Promise<BudgetResult> {
  const claude = await markClaudeTasks(db, ws)
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']),
    gte(schema.tasks.dueDate, addDays(today, -60)),
    lte(schema.tasks.dueDate, addDays(today, PLAN_HORIZON_DAYS)),
  ))
  const costs = await humanCosts(db, ws, rows)
  const drafted = new Set((rows.length ? await db.select({ id: schema.drafts.taskId }).from(schema.drafts).where(and(inArray(schema.drafts.taskId, rows.map(r => r.id)), eq(schema.drafts.status, 'offen'))) : []).map(r => r.id))
  const pinned = (t: TaskRow) => !!t.createdByUserId || t.milestone || !!t.experimentId || REDDIT.test(`${t.channel ?? ''} ${t.title}`)
  const byUser = new Map<string, TaskRow[]>()
  for (const t of rows) {
    const c = costs.get(t.id)!
    if (!c.userId || (c.min <= 0 && c.kind !== 'info')) continue
    byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), t])
  }
  const selfCap = selfPerDay(ws)
  const approveCap = approvalsPerDay(ws)
  const result: BudgetResult = { moved: 0, dropped: 0, claude }
  const movedIds: string[] = []
  for (const [userId, list] of byUser) {
    const budget = budgetOf(ws.settings, userId)
    const used = new Map<string, number>()
    const selfN = new Map<string, number>()
    const apprN = new Map<string, number>()
    const infoDay = new Set<string>()
    const add = (day: string, t: TaskRow) => {
      const c = costs.get(t.id)!
      let m = c.min
      if (c.kind === 'info' && !infoDay.has(day)) {
        infoDay.add(day)
        m += INFO_BUNDLE_MIN
      }
      used.set(day, (used.get(day) ?? 0) + m)
      if (c.kind === 'self') selfN.set(day, (selfN.get(day) ?? 0) + 1)
      else apprN.set(day, (apprN.get(day) ?? 0) + 1)
    }
    const costOn = (day: string, t: TaskRow) => {
      const c = costs.get(t.id)!
      return c.min + (c.kind === 'info' && !infoDay.has(day) ? INFO_BUNDLE_MIN : 0)
    }
    const fits = (day: string, t: TaskRow) => {
      const c = costs.get(t.id)!
      if (c.kind === 'self' ? (selfN.get(day) ?? 0) >= selfCap : (apprN.get(day) ?? 0) >= approveCap) return false
      const u = used.get(day) ?? 0
      const m = costOn(day, t)
      return u + m <= budget || (u === 0 && t.prio !== 'P3')
    }
    const fixed = (t: TaskRow) => t.dueDate! >= today && pinned(t)
    for (const t of list.filter(fixed)) add(t.dueDate!, t)
    const from = (t: TaskRow) => workday(t.dueDate! < today ? today : t.dueDate!)
    const first = (t: TaskRow) => t.plannedFor ?? t.dueDate!
    const free = list.filter(t => !fixed(t)).sort((a, b) => PRIO_RANK[a.prio]! - PRIO_RANK[b.prio]! || first(a).localeCompare(first(b)) || from(a).localeCompare(from(b)) || a.code.localeCompare(b.code))
    const last = addDays(today, PLAN_HORIZON_DAYS + 60)
    for (const t of free) {
      let day = from(t)
      while (day < last && !fits(day, t)) day = workday(addDays(day, 1))
      const late = day > addDays(first(t), DROP_AFTER_DAYS)
      const never = costs.get(t.id)!.min > budget
      if (t.prio === 'P3' && !drafted.has(t.id) && (late || never)) {
        await dropTask(db, ws, t, budget, never)
        result.dropped++
        continue
      }
      add(day, t)
      if (day === t.dueDate) continue
      await updateTask(db, t, { dueDate: day, ...(t.plannedFor ? {} : { plannedFor: t.dueDate }) }, { type: 'system' })
      movedIds.push(t.id)
      result.moved++
    }
  }
  if (result.moved || result.dropped) await logActivity(db, { workspaceId: ws.id, actor: 'agent', action: 'budget_planned', detail: { moved: result.moved, dropped: result.dropped, ids: movedIds }, at: now() })
  return result
}

export const DROP_NOTE = 'Fällt weg:'

async function dropTask(db: DbOrTx, ws: Workspace, t: TaskRow, budget: number, never: boolean): Promise<void> {
  const why = never
    ? `${DROP_NOTE} braucht mehr Zeit als dein Tagesbudget von ${budget} Minuten und hat geringe Wirkung.`
    : `${DROP_NOTE} passt seit über ${DROP_AFTER_DAYS} Tagen nicht in dein Tagesbudget von ${budget} Minuten und hat geringe Wirkung.`
  await updateTask(db, t, { status: 'verworfen', ...(t.plannedFor ? {} : { plannedFor: t.dueDate }) }, { type: 'agent' })
  await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: true, text: why, createdAt: now() })
  await logActivity(db, { workspaceId: ws.id, projectId: t.projectId, taskId: t.id, actor: 'agent', action: 'budget_dropped', detail: { title: t.title, reason: why.slice(DROP_NOTE.length).trim() }, at: now() })
}
