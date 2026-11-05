import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { TransitionError } from '~~/server/lib/tasks'
import { applyDraftAction, DraftStateError } from '~~/server/services/drafts'
import { approveAndSchedule } from '~~/server/services/approve'
import { cancelPosts } from '~~/server/lib/publish'

const body = z.object({
  action: z.enum(['approve', 'reject', 'posted']),
  postedUrl: httpUrl(1000).nullable().optional().or(z.literal('').transform(() => null)),
  reason: z.string().max(2000).nullable().optional(),
  dropTask: z.boolean().nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  if (!/^[0-9a-f-]{36}$/i.test(getRouterParam(event, 'id')!)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [own] = await db.select({ projectId: schema.tasks.projectId }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, getRouterParam(event, 'id')!), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!own) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, own.projectId, 'Entwurf nicht gefunden')
  try {
    if (input.action === 'approve') {
      const res = await approveAndSchedule(db, s.workspace, s.user.id, getRouterParam(event, 'id')!)
      if (!res) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
      return { ok: true, ...res }
    }
    const res = await applyDraftAction(db, s.workspace, s.user.id, getRouterParam(event, 'id')!, input.action, input)
    if (!res) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
    await cancelPosts(db, res.taskId)
    return { ok: true, taskId: res.taskId, taskDropped: res.taskDropped }
  }
  catch (err) {
    if (err instanceof TransitionError || err instanceof DraftStateError) throw createError({ statusCode: 409, statusMessage: err.message, data: err instanceof DraftStateError && err.newerId ? { newerId: err.newerId } : undefined })
    throw err
  }
})
