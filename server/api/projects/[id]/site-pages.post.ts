import { enqueueJob } from '~~/server/lib/jobs'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  if (!p.url?.trim()) throw createError({ statusCode: 400, statusMessage: 'Projekt hat keine Website' })
  await enqueueJob(db, 'site_read', { workspaceId: s.workspace.id, payload: { projectId: p.id }, dedupeKey: `site_read:${p.id}:now:${Date.now()}`, maxAttempts: 1 })
  return { ok: true }
})
