import { and, eq } from 'drizzle-orm'
import { schema } from '~~/server/lib/db'
import { deleteDocument } from '~~/server/lib/documents'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'member')
  const id = getRouterParam(event, 'docId')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [doc] = await db.select().from(schema.projectDocuments).where(and(eq(schema.projectDocuments.id, id), eq(schema.projectDocuments.projectId, p.id)))
  if (!doc) throw createError({ statusCode: 404, statusMessage: 'Unterlage nicht gefunden' })
  return deleteDocument(db, doc, { removeFacts: getQuery(event).facts === '1' })
})
