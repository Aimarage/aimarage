import { getDb } from '~~/server/lib/db'
import { deleteGrant } from '~~/server/lib/api/oauth'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  if (!(await deleteGrant(await getDb(), s.user.id, getRouterParam(event, 'id')!))) throw createError({ statusCode: 404, statusMessage: 'Verbindung nicht gefunden' })
  return { ok: true }
})
