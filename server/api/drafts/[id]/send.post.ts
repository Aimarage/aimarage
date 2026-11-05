import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { MailError, sendDraft } from '~~/server/lib/mail'
import { cancelPosts } from '~~/server/lib/publish'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await readBody<{ resend?: boolean } | null>(event).catch(() => null)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [row] = await db.select({ task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId)).where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, row.task.projectId, 'Entwurf nicht gefunden')
  try {
    await cancelPosts(db, row.task.id)
    return await sendDraft(db, s.workspace, { draftId: id, userId: s.user.id, mode: 'manual', resend: input?.resend === true })
  }
  catch (err) {
    if (err instanceof MailError) throw createError({ statusCode: err.code === 'already_sent' ? 409 : 400, statusMessage: err.message, data: err.code ? { code: err.code } : undefined })
    throw err
  }
})
