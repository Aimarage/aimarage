import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { dashboardView } from '~~/server/services/views'

const query = z.object({ project: z.string().max(60).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  return dashboardView(db, s.workspace, project, s.user.id, await accessOf(db, s), roleAtLeast(s.role, 'admin'))
})
