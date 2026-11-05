import { getDb } from '~~/server/lib/db'
import { dropQueuedTalk } from '~~/server/lib/talk'

const query = z.object({ note: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  const q = parseQuery(event, query)
  if (!(await dropQueuedTalk(db, t.id, q.note))) throw createError({ statusCode: 409, statusMessage: 'Der Agent hat die Nachricht schon gelesen' })
  return { ok: true }
})
