import { getDb } from '~~/server/lib/db'
import { checkConnection, listConnections } from '~~/server/lib/connections'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  if (!listConnections(s.workspace).some(c => c.id === id)) throw createError({ statusCode: 404, statusMessage: 'Verbindung nicht gefunden' })
  return checkConnection(await getDb(), s.workspace, id)
})
