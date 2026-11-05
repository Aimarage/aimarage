import { dropQueued } from '~~/server/lib/chat'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 404, statusMessage: 'Nachricht nicht gefunden' })
  const db = await getDb()
  const done = await dropQueued(db, { workspace: s.workspace, userId: s.user.id }, id.data)
  if (done === null) throw createError({ statusCode: 404, statusMessage: 'Nachricht nicht gefunden' })
  if (!done) throw createError({ statusCode: 409, statusMessage: 'Der Agent hat die Nachricht schon gelesen' })
  return { ok: true }
})
