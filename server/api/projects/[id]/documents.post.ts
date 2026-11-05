import { eq, sql } from 'drizzle-orm'
import { schema } from '~~/server/lib/db'
import { DocumentError, documentView, MAX_DOCS_PER_PROJECT, saveDocument } from '~~/server/lib/documents'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  const files = ((await readMultipartFormData(event)) ?? []).filter(x => x.name === 'file' && x.data?.length)
  if (!files.length) throw createError({ statusCode: 400, statusMessage: 'Keine Datei' })
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.projectDocuments).where(eq(schema.projectDocuments.projectId, p.id))
  if (n + files.length > MAX_DOCS_PER_PROJECT) throw createError({ statusCode: 400, statusMessage: `Höchstens ${MAX_DOCS_PER_PROJECT} Unterlagen je Projekt` })
  const added = []
  try {
    for (const f of files) added.push(documentView(await saveDocument(db, s.workspace, p, { name: f.filename ?? 'unterlage', data: new Uint8Array(f.data), userId: s.user.id })))
  }
  catch (err) {
    if (err instanceof DocumentError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
  return { documents: added }
})
