import { addDays, diffDays, isValidIso } from '~~/shared/utils/dates'
import { getDb } from '~~/server/lib/db'
import { calendarView } from '~~/server/services/views'

const query = z.object({
  project: z.string().max(60).optional(),
  from: z.string().refine(isValidIso),
  to: z.string().refine(isValidIso),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  if (q.to < q.from || diffDays(q.to, q.from) > 62) throw createError({ statusCode: 400, statusMessage: 'Zeitraum ungültig' })
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  return calendarView(db, s.workspace, project, q.from, addDays(q.to, 0), await accessOf(db, s))
})
