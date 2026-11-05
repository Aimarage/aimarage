import { desc, eq } from 'drizzle-orm'
import { schema } from '~~/server/lib/db'
import { DOC_ACCEPT, documentView, MAX_DOC_BYTES } from '~~/server/lib/documents'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event)
  const rows = await db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.projectId, p.id)).orderBy(desc(schema.projectDocuments.createdAt))
  return { documents: rows.map(documentView), accept: DOC_ACCEPT, maxMb: MAX_DOC_BYTES / 1024 / 1024 }
})
