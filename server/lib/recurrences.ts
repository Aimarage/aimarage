import { and, eq, gte, inArray } from 'drizzle-orm'
import { canSeeProject, type Access } from './access'
import type { DbOrTx } from './db'
import { schema } from './db'
import { updateTask } from './tasks'

type Recurrence = typeof schema.recurrences.$inferSelect

export async function loadRecurrence(db: DbOrTx, workspaceId: string, access: Access, id: string): Promise<Recurrence | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const [rec] = await db.select().from(schema.recurrences).where(and(eq(schema.recurrences.workspaceId, workspaceId), eq(schema.recurrences.id, id)))
  if (!rec || !canSeeProject(access, rec.projectId)) return null
  return rec
}

export async function endRecurrence(db: DbOrTx, rec: Recurrence, today: string, actor: { type: 'user' | 'agent' | 'system', userId?: string | null }): Promise<{ discarded: string[] }> {
  const untilDate = rec.untilDate && rec.untilDate < today ? rec.untilDate : today
  await db.update(schema.recurrences).set({ active: false, untilDate }).where(eq(schema.recurrences.id, rec.id))
  const open = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.recurrenceId, rec.id),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig']),
    gte(schema.tasks.dueDate, today),
  ))
  const discarded: string[] = []
  for (const t of open) {
    if (t.postedUrl) continue
    const kept = await db.select({ id: schema.drafts.id }).from(schema.drafts)
      .where(and(eq(schema.drafts.taskId, t.id), eq(schema.drafts.status, 'freigegeben'))).limit(1)
    if (kept.length) continue
    await updateTask(db, t, { status: 'verworfen' }, actor)
    discarded.push(t.code)
  }
  return { discarded }
}
