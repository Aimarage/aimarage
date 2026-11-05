import { revokeSession, SESSION_COOKIE } from '~~/server/lib/auth'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!/^[0-9a-f]{64}$/.test(id) || !(await revokeSession(await getDb(), s.user.id, id))) throw createError({ statusCode: 404, statusMessage: 'Sitzung nicht gefunden' })
  if (id === s.session?.id) deleteCookie(event, SESSION_COOKIE, { path: '/' })
  return { ok: true, current: id === s.session?.id }
})
