import { agentReady } from '~~/server/lib/agent'
import { getDb } from '~~/server/lib/db'
import { enqueueJob } from '~~/server/lib/jobs'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  if (!agentReady(s.workspace)) throw createError({ statusCode: 409, statusMessage: 'Agent nicht konfiguriert' })
  await enqueueJob(db, 'draft_task', { workspaceId: s.workspace.id, payload: { taskId: t.id }, dedupeKey: `draft_task:${t.id}:${Date.now()}` })
  return { ok: true }
})
