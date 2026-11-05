import { enqueueJob } from '~~/server/lib/jobs'
import { setBingSite } from '~~/server/lib/bing-webmaster'

const body = z.object({ site: z.string().trim().min(4).max(500).regex(/^https?:\/\/\S+$/).nullable() })

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  if (!s.workspace.settings?.apps?.bing?.secret) throw createError({ statusCode: 400, statusMessage: 'Kein Bing-API-Schlüssel eingetragen' })
  const input = await parseBody(event, body)
  await setBingSite(db, p.id, input.site)
  if (input.site) await enqueueJob(db, 'search_sync', { workspaceId: s.workspace.id, payload: { projectId: p.id }, dedupeKey: `search_sync:${p.id}:bing:${Date.now()}`, maxAttempts: 1 })
  return { ok: true }
})
