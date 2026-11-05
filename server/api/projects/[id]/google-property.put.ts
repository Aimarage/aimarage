import { enqueueJob } from '~~/server/lib/jobs'
import { setProperty } from '~~/server/lib/search-console'

const body = z.object({ property: z.string().trim().min(4).max(500).regex(/^(sc-domain:[\w.-]+|https?:\/\/\S+)$/) })

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  if (!p.setup?.google?.secret) throw createError({ statusCode: 400, statusMessage: 'Nicht mit Google verbunden' })
  const input = await parseBody(event, body)
  await setProperty(db, p.id, input.property)
  await enqueueJob(db, 'search_sync', { workspaceId: s.workspace.id, payload: { projectId: p.id }, dedupeKey: `search_sync:${p.id}:set:${Date.now()}`, maxAttempts: 1 })
  return { ok: true }
})
