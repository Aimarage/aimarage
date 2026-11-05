import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { now } from '~~/server/lib/clock'
import { inboxSummary } from '~~/server/lib/inbox'

const query = z.object({ project: z.string().max(60).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  if (!roleAtLeast(s.role, 'admin')) return { lines: [] }
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  const lines = await inboxSummary(db, s.workspace.id, { projectIds: project ? [project.id] : null, since: new Date(now().getTime() - 86_400_000) })
  return { lines }
})
