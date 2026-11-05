import { getDb } from '~~/server/lib/db'
import { globalSearch } from '~~/server/lib/search'

const query = z.object({ q: z.string().max(100).default('') })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  return globalSearch(db, s.workspace.id, await accessOf(db, s), q.q)
})
