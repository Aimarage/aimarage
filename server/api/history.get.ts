import { eq } from 'drizzle-orm'
import { addDays } from '~~/shared/utils/dates'
import { today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { projectCond } from '~~/server/lib/access'
import { loadHistory } from '~~/server/lib/history'

const query = z.object({
  project: z.string().max(60).optional(),
  days: z.coerce.number().int().min(7).max(90).default(30),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  const access = await accessOf(db, s)
  const to = today(s.workspace.timezone)
  const from = addDays(to, -(q.days - 1))
  const scope = project ? eq(schema.tasks.projectId, project.id) : projectCond(access, schema.tasks.projectId)
  return { days: q.days, ...await loadHistory(db, { workspaceId: s.workspace.id, scope, from, to, timezone: s.workspace.timezone }) }
})
