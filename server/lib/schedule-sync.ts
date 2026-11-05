import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { mcpApproveConfig } from '../../shared/utils/mcp-approve'
import { now } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { zonedToUtc } from './publish'

type Task = typeof schema.tasks.$inferSelect

// Der Termin der Aufgabe ist maßgeblich: geplanter Versand (Post, Mail, Artikel, Antwort) und Einspruchsfrist folgen ihm.
// Nie vor der Einspruchsfrist einer Freigabe durch Claude/KI-Prüfer und nie in der Vergangenheit.
export async function syncSchedule(db: DbOrTx, task: Pick<Task, 'id' | 'workspaceId' | 'dueDate' | 'dueTime'>): Promise<number> {
  if (!task.dueDate) return 0
  const [ws] = await db.select({ timezone: schema.workspaces.timezone, settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, task.workspaceId))
  if (!ws) return 0
  const n = now()
  const planned = zonedToUtc(task.dueDate, task.dueTime, ws.timezone)
  const delay = mcpApproveConfig(ws.settings?.mcpApprove).delayMin * 60_000
  const drafts = await db.select().from(schema.drafts).where(and(eq(schema.drafts.taskId, task.id), eq(schema.drafts.status, 'freigegeben')))
  let earliest = n.getTime()
  for (const d of drafts) if ((d.approvedVia === 'mcp' || d.approvedVia === 'reviewer') && d.approvedAt) earliest = Math.max(earliest, d.approvedAt.getTime() + delay)
  const at = new Date(Math.max(planned.getTime(), earliest))
  let changed = 0
  const ids = drafts.map(d => d.id)
  if (ids.length) {
    const r = await db.update(schema.drafts).set({ releaseAt: at }).where(and(inArray(schema.drafts.id, ids), isNotNull(schema.drafts.releaseAt), sql`${schema.drafts.releaseAt} <> ${at}`)).returning({ id: schema.drafts.id })
    changed += r.length
  }
  const posts = await db.select({ id: schema.socialPosts.id, at: schema.socialPosts.scheduledAt }).from(schema.socialPosts).where(and(eq(schema.socialPosts.taskId, task.id), eq(schema.socialPosts.status, 'geplant')))
  for (const p of posts) {
    if (p.at.getTime() === at.getTime()) continue
    await db.update(schema.socialPosts).set({ scheduledAt: at, updatedAt: n }).where(eq(schema.socialPosts.id, p.id))
    await db.update(schema.jobs).set({ runAt: at }).where(and(eq(schema.jobs.dedupeKey, `publish_post:${p.id}`), eq(schema.jobs.status, 'queued')))
    changed++
  }
  const mails = await db.select({ id: schema.mails.id, at: schema.mails.scheduledAt }).from(schema.mails).where(and(eq(schema.mails.taskId, task.id), eq(schema.mails.direction, 'out'), eq(schema.mails.status, 'geplant')))
  for (const m of mails) {
    if (m.at && m.at.getTime() === at.getTime()) continue
    await db.update(schema.mails).set({ scheduledAt: at }).where(eq(schema.mails.id, m.id))
    await db.update(schema.jobs).set({ runAt: at }).where(and(eq(schema.jobs.dedupeKey, `send_mail:${m.id}`), eq(schema.jobs.status, 'queued')))
    changed++
  }
  if (ids.length) {
    const keys = ids.flatMap(id => [`publish_article:${id}`, `publish_article:${id}:retry`])
    const r1 = await db.update(schema.jobs).set({ runAt: at }).where(and(inArray(schema.jobs.dedupeKey, keys), eq(schema.jobs.status, 'queued'), sql`${schema.jobs.runAt} <> ${at}`)).returning({ id: schema.jobs.id })
    const r2 = await db.update(schema.jobs).set({ runAt: at }).where(and(eq(schema.jobs.type, 'listening_reply'), inArray(sql`${schema.jobs.payload}->>'draftId'`, ids), eq(schema.jobs.status, 'queued'), sql`${schema.jobs.runAt} <> ${at}`)).returning({ id: schema.jobs.id })
    changed += r1.length + r2.length
  }
  return changed
}

// Einmalig beim Deploy: Versand und Einspruchsfrist offener Aufgaben ab heute auf ihren Termin bringen.
export async function syncAllSchedules(db: DbOrTx, ws: { id: string }, today: string): Promise<number> {
  const rows = await db.select({ id: schema.tasks.id, workspaceId: schema.tasks.workspaceId, dueDate: schema.tasks.dueDate, dueTime: schema.tasks.dueTime }).from(schema.tasks)
    .where(and(eq(schema.tasks.workspaceId, ws.id), eq(schema.tasks.status, 'freigegeben'), sql`${schema.tasks.dueDate} >= ${today}`))
  let n = 0
  for (const t of rows) n += await syncSchedule(db, t)
  return n
}
