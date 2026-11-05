import { and, eq } from 'drizzle-orm'
import { schema } from '~~/server/lib/db'
import { openFile } from '~~/server/lib/media'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event)
  const id = getRouterParam(event, 'itemId')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [item] = await db.select().from(schema.mediaLibrary).where(and(eq(schema.mediaLibrary.id, id), eq(schema.mediaLibrary.projectId, p.id)))
  if (!item) throw createError({ statusCode: 404 })
  const file = await openFile(item.file)
  if (!file) throw createError({ statusCode: 404, statusMessage: 'Datei fehlt' })
  setHeader(event, 'Content-Type', item.mime)
  setHeader(event, 'Content-Length', file.size)
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return sendStream(event, await file.stream())
})
