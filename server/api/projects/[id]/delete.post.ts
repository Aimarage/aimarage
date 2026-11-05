import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { DeletionError, deleteProject } from '~~/server/lib/deletion'

const body = z.object({ name: z.string().max(200) })

// Projekt endgültig löschen (Admins und Inhaber), Bestätigung mit dem Projektnamen.
export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select({ name: schema.projects.name }).from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  const input = await parseBody(event, body)
  if (input.name.trim() !== p.name.trim()) throw createError({ statusCode: 400, statusMessage: 'Der Name stimmt nicht' })
  try {
    const r = await deleteProject(db, s.workspace.id, id, { userId: s.user.id, via: 'web' })
    return { ok: true, name: r.name }
  }
  catch (err) {
    if (err instanceof DeletionError) throw createError({ statusCode: err.status, statusMessage: err.message })
    throw err
  }
})
