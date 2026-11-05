import { today } from '~~/server/lib/clock'
import { getDb } from '~~/server/lib/db'
import { listGoals } from '~~/server/lib/goals'

const query = z.object({ project: z.string().max(60).optional(), all: z.string().optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  const d = today(s.workspace.timezone)
  return { today: d, goals: await listGoals(db, s.workspace.id, d, { projectId: project?.id ?? null, access: await accessOf(db, s), activeOnly: !q.all }) }
})
