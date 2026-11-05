import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [r] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.id, id), eq(schema.agentRuns.workspaceId, s.workspace.id)))
  if (!r) throw createError({ statusCode: 404 })
  if (r.taskId) await loadTask(db, s, r.taskId)
  else if (!(await accessOf(db, s)).all) throw createError({ statusCode: 404 })
  return { ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null }
})
