import { and, eq } from 'drizzle-orm'
import { schema } from '~~/server/lib/db'
import { deleteFundusItem } from '~~/server/lib/fundus'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'member')
  const id = getRouterParam(event, 'itemId')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [item] = await db.select().from(schema.mediaLibrary).where(and(eq(schema.mediaLibrary.id, id), eq(schema.mediaLibrary.projectId, p.id)))
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Datei nicht gefunden' })
  await deleteFundusItem(db, item)
  return { ok: true }
})
