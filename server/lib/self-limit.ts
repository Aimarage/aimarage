import { and, eq, isNotNull, isNull, or } from 'drizzle-orm'
import { addDays, weekday } from '../../shared/utils/dates'
import type { DbOrTx } from './db'
import { schema } from './db'
import { updateTask, type TaskRow } from './tasks'

type Workspace = Pick<typeof schema.workspaces.$inferSelect, 'id' | 'settings'>

export const SELF_PER_DAY = 3

export function selfPerDay(ws: Workspace): number {
  const n = ws.settings?.selfPerDay
  return typeof n === 'number' && n >= 1 ? Math.floor(n) : SELF_PER_DAY
}

function workday(d: string): string {
  const w = weekday(d)
  return w === 6 ? addDays(d, 2) : w === 7 ? addDays(d, 1) : d
}

const PRIO_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 }

// Selbst-Aufgaben (wie ownerOf: zugewiesen, ohne Agenten-Entwurf) je Person auf höchstens n pro Tag verteilen.
// Überfällige rücken auf heute bzw. den nächsten freien Werktag nach, Überschuss nach Priorität weiter.
// Fest sind: vom Menschen angelegte, mit Uhrzeit oder Meilenstein, solange nicht überfällig. Sie zählen mit.
export async function spreadSelfTasks(db: DbOrTx, ws: Workspace, today: string): Promise<number> {
  const limit = selfPerDay(ws)
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    eq(schema.tasks.status, 'geplant'),
    eq(schema.tasks.forClaude, false),
    or(isNull(schema.tasks.agentStep), isNull(schema.tasks.draftKind)),
    isNotNull(schema.tasks.assigneeUserId),
    isNotNull(schema.tasks.dueDate),
  ))
  const byUser = new Map<string, TaskRow[]>()
  for (const t of rows) byUser.set(t.assigneeUserId!, [...(byUser.get(t.assigneeUserId!) ?? []), t])
  const start = workday(today)
  let moved = 0
  for (const list of byUser.values()) {
    const count = new Map<string, number>()
    const fixed = (t: TaskRow) => t.dueDate! >= today && (!!t.createdByUserId || !!t.dueTime || t.milestone)
    for (const t of list.filter(fixed)) count.set(t.dueDate!, (count.get(t.dueDate!) ?? 0) + 1)
    const from = (t: TaskRow) => (t.dueDate! < today ? start : t.dueDate!)
    const free = list.filter(t => !fixed(t)).sort((a, b) => from(a).localeCompare(from(b)) || PRIO_RANK[a.prio]! - PRIO_RANK[b.prio]! || a.dueDate!.localeCompare(b.dueDate!) || a.code.localeCompare(b.code))
    for (const t of free) {
      let day = from(t)
      while ((count.get(day) ?? 0) >= limit) day = workday(addDays(day, 1))
      count.set(day, (count.get(day) ?? 0) + 1)
      if (day === t.dueDate) continue
      await updateTask(db, t, { dueDate: day }, { type: 'system' })
      moved++
    }
  }
  return moved
}
