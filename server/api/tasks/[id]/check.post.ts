import { OPEN_STATUSES } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { checkAndClose } from '~~/server/lib/task-check'
import { updateTask } from '~~/server/lib/tasks'

const body = z.object({
  link: httpUrl(1000).nullable().optional().or(z.literal('').transform(() => null)),
  orDone: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  const r = await checkAndClose(db, s.workspace, t, { type: 'user', userId: s.user.id }, { link: input.link ?? null, search: true })
  if (!r.kind && input.orDone && OPEN_STATUSES.includes(t.status)) {
    await updateTask(db, t, { status: 'erledigt' }, { type: 'user', userId: s.user.id })
    return { ...r, closed: true }
  }
  return r
})
