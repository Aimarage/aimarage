import { and, eq } from 'drizzle-orm'
import { schema } from '~~/server/lib/db'
import { readDocumentFile } from '~~/server/lib/documents'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event)
  const id = getRouterParam(event, 'docId')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [doc] = await db.select().from(schema.projectDocuments).where(and(eq(schema.projectDocuments.id, id), eq(schema.projectDocuments.projectId, p.id)))
  if (!doc) throw createError({ statusCode: 404 })
  const data = await readDocumentFile(doc).catch(() => null)
  if (!data) throw createError({ statusCode: 404, statusMessage: 'Datei fehlt' })
  setHeader(event, 'Content-Type', doc.mime)
  setHeader(event, 'Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`)
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return data
})
