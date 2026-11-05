import { isValidIso } from '~~/shared/utils/dates'
import { today } from '~~/server/lib/clock'
import { getDb } from '~~/server/lib/db'
import { saveGoals } from '~~/server/lib/goals'

const body = z.object({
  project: z.string().max(60),
  label: z.string().trim().min(1).max(120),
  targetValue: z.number().finite().min(0).nullable().optional(),
  deadline: z.string().refine(isValidIso).nullable().optional(),
  metricKey: z.string().trim().max(40).regex(/^[a-z0-9_]*$/).nullable().optional(),
  mode: z.enum(['sum', 'last', 'month']).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const project = await resolveProject(db, s, input.project)
  if (!project) throw createError({ statusCode: 400, statusMessage: 'Projekt fehlt' })
  const [g] = await saveGoals(db, s.workspace.id, project.id, [{ label: input.label, targetValue: input.targetValue ?? null, deadline: input.deadline ?? null, metricKey: input.metricKey || null, mode: input.mode }], today(s.workspace.timezone))
  return { id: g!.id }
})
