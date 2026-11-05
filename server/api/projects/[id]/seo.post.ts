import { enqueueJob } from '~~/server/lib/jobs'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  if (!p.url) throw createError({ statusCode: 400, statusMessage: 'Projekt hat keine Website-Adresse' })
  await enqueueJob(db, 'seo_audit', { workspaceId: s.workspace.id, payload: { projectId: p.id }, dedupeKey: `seo_audit:${p.id}:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 1 })
  return { ok: true }
})
