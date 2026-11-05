import { listSessions } from '~~/server/lib/auth'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const rows = await listSessions(await getDb(), s.user.id)
  return { sessions: rows.map(r => ({ ...r, current: r.id === s.session?.id })) }
})
