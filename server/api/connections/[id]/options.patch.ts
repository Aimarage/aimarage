import { getDb } from '~~/server/lib/db'
import { listConnections, updateSettings } from '~~/server/lib/connections'
import { YT_CATEGORIES, YT_PRIVACY, youtubeOptions } from '~~/server/lib/platforms/youtube'

const body = z.object({
  categoryId: z.enum(YT_CATEGORIES).optional(),
  privacy: z.enum(YT_PRIVACY).optional(),
  synthetic: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  const input = await parseBody(event, body)
  const conn = listConnections(s.workspace).find(c => c.id === id)
  if (!conn) throw createError({ statusCode: 404, statusMessage: 'Verbindung nicht gefunden' })
  if (conn.provider !== 'youtube') throw createError({ statusCode: 400, statusMessage: 'Nur für YouTube' })
  const ext = { ...conn.ext, ...(input.categoryId ? { categoryId: input.categoryId } : {}), ...(input.privacy ? { privacy: input.privacy } : {}), ...(input.synthetic !== undefined ? { synthetic: String(input.synthetic) } : {}) }
  await updateSettings(await getDb(), s.workspace.id, st => ({ ...st, connections: (st.connections ?? []).map(c => (c.id === id ? { ...c, ext } : c)) }))
  return { ok: true, options: youtubeOptions({ ext }) }
})
