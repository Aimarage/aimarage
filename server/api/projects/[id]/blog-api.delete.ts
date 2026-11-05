import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404 })
  const { blogApi: _, ...setup } = p.setup ?? {}
  await db.update(schema.projects).set({ setup }).where(eq(schema.projects.id, p.id))
  return { ok: true }
})
