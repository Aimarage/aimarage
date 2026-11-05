import { agentReady } from '~~/server/lib/agent'
import { enqueueJob } from '~~/server/lib/jobs'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  if (!agentReady(s.workspace)) throw createError({ statusCode: 400, statusMessage: 'Agent nicht konfiguriert' })
  const queued = await enqueueJob(db, 'geo_check', { workspaceId: s.workspace.id, payload: { projectId: p.id }, dedupeKey: `geo_check:${p.id}:${new Date().toISOString().slice(0, 15)}`, maxAttempts: 1 })
  return { ok: true, queued }
})
