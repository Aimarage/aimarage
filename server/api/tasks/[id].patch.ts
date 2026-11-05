import { CATEGORIES, DRAFT_KINDS, PRIOS, STATUSES } from '~~/shared/utils/domain'
import { isValidIso, isValidTime } from '~~/shared/utils/dates'
import { getDb } from '~~/server/lib/db'
import { TransitionError, updateTask } from '~~/server/lib/tasks'

const body = z.object({
  project: z.string().max(60).nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  channel: z.string().max(200).nullable().optional(),
  language: z.string().max(10).nullable().optional(),
  dueDate: z.string().refine(isValidIso).nullable().optional(),
  dueTime: z.string().refine(isValidTime).nullable().optional(),
  durationMin: z.number().int().min(5).max(24 * 60).optional(),
  estimateMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  prio: z.enum(PRIOS).optional(),
  status: z.enum(STATUSES).optional(),
  agentStep: z.string().max(300).nullable().optional(),
  humanStep: z.string().max(300).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  draftKind: z.enum(DRAFT_KINDS).nullable().optional(),
  targetUrl: httpUrl(1000).nullable().optional().or(z.literal('').transform(() => null)),
  metric: z.string().max(300).nullable().optional(),
  followUpOn: z.string().refine(isValidIso).nullable().optional(),
  milestone: z.boolean().optional(),
  postedUrl: httpUrl(1000).nullable().optional().or(z.literal('').transform(() => null)),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  await assertMember(db, s.workspace.id, input.assigneeUserId)
  const { project, ...patch } = input
  const next: Parameters<typeof updateTask>[2] = { ...patch }
  if (project !== undefined) next.projectId = (await resolveProject(db, s, project))?.id ?? null
  try {
    const row = await updateTask(db, t, next, { type: 'user', userId: s.user.id })
    return { ok: true, status: row.status }
  }
  catch (err) {
    if (err instanceof TransitionError) throw createError({ statusCode: 409, statusMessage: err.message })
    throw err
  }
})
