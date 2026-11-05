import { and, eq } from 'drizzle-orm'
import { schema } from '~~/server/lib/db'
import { DocumentError, saveDocumentFact } from '~~/server/lib/documents'

const body = z.object({ index: z.number().int().min(0).max(50) })

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'docId')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [doc] = await db.select().from(schema.projectDocuments).where(and(eq(schema.projectDocuments.id, id), eq(schema.projectDocuments.projectId, p.id)))
  if (!doc) throw createError({ statusCode: 404, statusMessage: 'Unterlage nicht gefunden' })
  try {
    return { fact: await saveDocumentFact(db, s.workspace, doc, input.index, s.user.id) }
  }
  catch (err) {
    if (err instanceof DocumentError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
