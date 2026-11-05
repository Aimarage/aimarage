import { isValidIso } from '~~/shared/utils/dates'
import { logActivity } from '~~/server/lib/activity'
import { today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({
  metric: z.string().trim().min(1).max(100),
  value: z.number().finite(),
  note: z.string().max(1000).nullable().optional(),
  measuredOn: z.string().refine(isValidIso).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  await db.insert(schema.results).values({ taskId: t.id, metric: input.metric, value: input.value, note: input.note ?? null, measuredOn: input.measuredOn ?? today(s.workspace.timezone), createdByUserId: s.user.id })
  await logActivity(db, { workspaceId: s.workspace.id, projectId: t.projectId, taskId: t.id, actor: 'user', userId: s.user.id, action: 'result_added', detail: { title: t.title, metric: input.metric, value: input.value } })
  return { ok: true }
})
