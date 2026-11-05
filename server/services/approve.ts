import { eq } from 'drizzle-orm'
import type { Db } from '../lib/db'
import { schema } from '../lib/db'
import { canPublishTask } from '../lib/outlets'
import { assertXBudget, outletReady, plannedAt, PublishError, schedulePost } from '../lib/publish'
import { blogApiReady, isArticleTask, scheduleArticle } from '../lib/blog-api'
import { applyDraftAction } from './drafts'

type Workspace = typeof schema.workspaces.$inferSelect

export interface ApproveResult {
  taskId: string
  publishAt?: string
  scheduledAt?: string
  warning?: string
}

export async function approveAndSchedule(db: Db, ws: Workspace, userId: string, draftId: string, opts: { via?: string } = {}): Promise<ApproveResult | null> {
  await budgetBeforeApprove(db, ws, draftId)
  const res = await applyDraftAction(db, ws, userId, draftId, 'approve')
  if (!res) return null
  if (opts.via) await db.update(schema.drafts).set({ approvedVia: opts.via }).where(eq(schema.drafts.id, draftId))
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, res.taskId))
  const project = task?.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftId))
  if (task && draft && isArticleTask(task, draft) && blogApiReady(project)) {
    const at = plannedAt(task, ws.timezone)
    await scheduleArticle(db, ws, { task, draft, mode: 'manual', at, userId })
    return { taskId: res.taskId, publishAt: at.toISOString() }
  }
  if (!task || !canPublishTask(task) || !outletReady(ws, project, task)) return { taskId: res.taskId }
  try {
    const post = await schedulePost(db, ws, { task, draft: draft!, project, mode: 'manual', at: plannedAt(task, ws.timezone), userId })
    return { taskId: res.taskId, scheduledAt: post.scheduledAt.toISOString() }
  }
  catch (err) {
    if (err instanceof PublishError) return { taskId: res.taskId, warning: err.message }
    throw err
  }
}

// X über gehostetes Zernio: reicht das Dienste-Budget nicht, gar nicht erst freigeben (Limit-Dialog, Entwurf bleibt offen).
async function budgetBeforeApprove(db: Db, ws: Workspace, draftId: string): Promise<void> {
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId)).where(eq(schema.drafts.id, draftId))
  if (!row || row.task.workspaceId !== ws.id || !canPublishTask(row.task) || row.draft.status !== 'offen') return
  const project = row.task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, row.task.projectId)))[0] ?? null : null
  await assertXBudget(db, ws, row.task, row.draft, project)
}
