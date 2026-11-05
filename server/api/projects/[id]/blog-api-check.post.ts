import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { BlogApiError, checkBlogApi } from '~~/server/lib/blog-api'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404 })
  try {
    return await checkBlogApi(db, s.workspace, p)
  }
  catch (err) {
    if (err instanceof BlogApiError) return { ok: false, error: err.message }
    throw err
  }
})
