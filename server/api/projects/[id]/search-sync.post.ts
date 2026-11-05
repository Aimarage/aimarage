import { enqueueJob } from '~~/server/lib/jobs'
import { bingWanted } from '~~/server/lib/bing-webmaster'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  if (!p.setup?.google?.property && !bingWanted(s.workspace, p)) throw createError({ statusCode: 400, statusMessage: 'Noch keine Website gewählt' })
  await enqueueJob(db, 'search_sync', { workspaceId: s.workspace.id, payload: { projectId: p.id }, dedupeKey: `search_sync:${p.id}:now:${Date.now()}`, maxAttempts: 1 })
  return { ok: true }
})
