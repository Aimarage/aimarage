import { and, eq } from 'drizzle-orm'
import { now } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { canPublishTask } from '~~/server/lib/outlets'
import { assertXBudget, plannedAt, PublishError, schedulePost, validatePost } from '~~/server/lib/publish'
import { TransitionError } from '~~/server/lib/tasks'
import { applyDraftAction, DraftStateError } from '~~/server/services/drafts'

const body = z.object({
  when: z.enum(['now', 'planned']),
  platforms: z.array(z.string().max(40)).max(20).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, row.task.projectId, 'Entwurf nicht gefunden')
  if (!canPublishTask(row.task)) throw createError({ statusCode: 400, statusMessage: 'Nur Social-Beiträge können gepostet werden (Communities, Foren und Mails nie)' })
  if (row.draft.status !== 'offen' && row.draft.status !== 'freigegeben') throw createError({ statusCode: 409, statusMessage: `Entwurf ist ${row.draft.status}` })
  if (input.platforms) await db.update(schema.drafts).set({ platforms: input.platforms }).where(eq(schema.drafts.id, id))
  try {
    const project0 = row.task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, row.task.projectId)))[0] ?? null : null
    validatePost(s.workspace, row.task, { ...row.draft, platforms: input.platforms ?? row.draft.platforms }, project0)
    await assertXBudget(db, s.workspace, row.task, { ...row.draft, platforms: input.platforms ?? row.draft.platforms }, project0)
    if (row.draft.status === 'offen') await applyDraftAction(db, s.workspace, s.user.id, id, 'approve')
    const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id))
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, row.task.id))
    const project = task!.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task!.projectId)))[0] ?? null : null
    const at = input.when === 'now' ? now() : plannedAt(task!, s.workspace.timezone)
    const post = await schedulePost(db, s.workspace, { task: task!, draft: draft!, project, mode: 'manual', at, userId: s.user.id })
    return { ok: true, postId: post.id, at: post.scheduledAt.toISOString(), live: !!s.workspace.settings?.publishLive }
  }
  catch (err) {
    if (err instanceof PublishError || err instanceof DraftStateError || err instanceof TransitionError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
