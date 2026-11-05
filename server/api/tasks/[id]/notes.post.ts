import { logActivity } from '~~/server/lib/activity'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({ text: z.string().trim().min(1).max(5000) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  await db.insert(schema.taskNotes).values({ taskId: t.id, userId: s.user.id, text: input.text })
  await logActivity(db, { workspaceId: s.workspace.id, projectId: t.projectId, taskId: t.id, actor: 'user', userId: s.user.id, action: 'note_added', detail: { title: t.title } })
  return { ok: true }
})
