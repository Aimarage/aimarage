import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { McpApproveError, stopRelease } from '~~/server/lib/mcp-approve'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [own] = await db.select({ projectId: schema.tasks.projectId }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!own) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, own.projectId, 'Entwurf nicht gefunden')
  try {
    const r = await stopRelease(db, s.workspace, s.user.id, id)
    if (!r) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
    return { ok: true, taskId: r.taskId }
  }
  catch (err) {
    if (err instanceof McpApproveError) throw createError({ statusCode: err.status, statusMessage: err.message })
    throw err
  }
})
