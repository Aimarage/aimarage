import { and, desc, eq, gt, like } from 'drizzle-orm'
import { addDays } from '../../shared/utils/dates'
import { obsoleteReason, STALE_KEEP } from '../../shared/utils/stale'
import { draftChecks } from '../../shared/utils/talk'
import { logActivity } from '../lib/activity'
import { now, today } from '../lib/clock'
import type { Db } from '../lib/db'
import { schema } from '../lib/db'
import { enqueueJob } from '../lib/jobs'
import { updateTask } from '../lib/tasks'
import { isConversationTask, isListeningTask, repliesItself } from '../../shared/utils/listening'
import { rememberTone } from '../lib/conversation'

export class DraftStateError extends Error {
  constructor(message: string, readonly newerId: string | null = null) {
    super(message)
  }
}

export const NEWER_DRAFT = 'Inzwischen gibt es eine neuere Fassung'

export type DraftAction = 'approve' | 'reject' | 'posted'

export async function applyDraftAction(db: Db, ws: typeof schema.workspaces.$inferSelect, userId: string, draftId: string, action: DraftAction, opts: { postedUrl?: string | null, reason?: string | null, dropTask?: boolean | null } = {}) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
      .where(and(eq(schema.drafts.id, draftId), eq(schema.tasks.workspaceId, ws.id)))
    if (!row) return null
    const { draft, task } = row
    const allowed = action === 'posted' ? ['offen', 'freigegeben'] : ['offen']
    const [newer] = await tx.select({ id: schema.drafts.id }).from(schema.drafts)
      .where(and(eq(schema.drafts.taskId, task.id), gt(schema.drafts.version, draft.version))).orderBy(desc(schema.drafts.version)).limit(1)
    if (newer && (action === 'approve' || !allowed.includes(draft.status))) throw new DraftStateError(NEWER_DRAFT, newer.id)
    if (!allowed.includes(draft.status)) throw new DraftStateError(`Entwurf ist ${draft.status}`)
    if (action !== 'reject' && task.doneAt && ['wartet', 'erledigt', 'ausgewertet'].includes(task.status)) throw new DraftStateError(draft.kind === 'mail' ? 'Schon gesendet' : 'Schon erledigt')
    const actor = { type: 'user' as const, userId }
    if (action === 'approve') {
      const notes = await tx.select({ id: schema.taskNotes.id, text: schema.taskNotes.text, byAgent: schema.taskNotes.byAgent, createdAt: schema.taskNotes.createdAt }).from(schema.taskNotes)
        .where(and(eq(schema.taskNotes.taskId, task.id), eq(schema.taskNotes.byAgent, true), like(schema.taskNotes.text, 'Info nötig:%')))
      if (draftChecks(notes, draft.createdAt).some(c => c.kind === 'info')) throw new DraftStateError('Der Agent braucht erst eine Antwort von dir')
      await tx.update(schema.drafts).set({ status: 'freigegeben', approvedByUserId: userId, approvedAt: now() }).where(eq(schema.drafts.id, draft.id))
      if (task.status !== 'freigegeben') await updateTask(tx as unknown as Db, task, { status: 'freigegeben' }, actor)
      if (repliesItself(task)) await enqueueJob(tx, 'listening_reply', { workspaceId: ws.id, payload: { taskId: task.id, draftId: draft.id }, dedupeKey: `listening_reply:${draft.id}`, maxAttempts: 1 })
    }
    else if (action === 'reject') {
      await tx.update(schema.drafts).set({ status: 'verworfen' }).where(eq(schema.drafts.id, draft.id))
      // Aufgabe ganz verwerfen, wenn gewünscht oder der Grund sie überflüssig macht (doppelt, entfällt ...); sonst schreibt der Agent neu.
      const drop = opts.dropTask ?? (isListeningTask(task) || obsoleteReason(opts.reason))
      if (opts.reason) await tx.insert(schema.taskNotes).values({ taskId: task.id, userId, text: `Entwurf v${draft.version} verworfen: ${opts.reason}`, createdAt: now() })
      else if (drop) await tx.insert(schema.taskNotes).values({ taskId: task.id, userId, text: `Entwurf v${draft.version} verworfen, Aufgabe entfällt.`, createdAt: now() })
      if (!drop && obsoleteReason(opts.reason)) await tx.insert(schema.taskNotes).values({ taskId: task.id, userId, text: `${STALE_KEEP} Aufgabe bleibt trotz Verwerfungsgrund.`, createdAt: new Date(now().getTime() + 1) })
      if (drop && task.status !== 'verworfen') await updateTask(tx as unknown as Db, task, { status: 'verworfen' }, actor)
      else if (task.status === 'entwurf_fertig' || task.status === 'freigegeben') await updateTask(tx as unknown as Db, task, { status: 'geplant' }, actor)
      if (task.projectId && isConversationTask(task)) await rememberTone(tx, task.projectId, { rejected: { text: draft.body, reason: opts.reason ?? null } })
      await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'user', userId, action: 'draft_rejected', detail: { title: task.title, version: draft.version } })
      return { taskId: task.id, taskDropped: drop }
    }
    else {
      if (draft.status === 'offen') await tx.update(schema.drafts).set({ status: 'freigegeben', approvedByUserId: userId, approvedAt: now() }).where(eq(schema.drafts.id, draft.id))
      const isMail = draft.kind === 'mail'
      await updateTask(tx as unknown as Db, task, {
        status: isMail ? 'wartet' : 'erledigt',
        postedUrl: opts.postedUrl ?? task.postedUrl,
        ...(isMail && !task.followUpOn ? { followUpOn: addDays(today(ws.timezone), 7) } : {}),
      }, actor)
      if (isMail) await tx.update(schema.tasks).set({ doneAt: now() }).where(eq(schema.tasks.id, task.id))
    }
    return { taskId: task.id, taskDropped: false }
  })
}
