import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { logActivity } from '~~/server/lib/activity'
import { revokeApiToken } from '~~/server/lib/api/tokens'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!(await revokeApiToken(db, s.user.id, id, { workspaceId: s.workspace.id, admin: roleAtLeast(s.role, 'admin') }))) throw createError({ statusCode: 404, statusMessage: 'Token nicht gefunden' })
  await logActivity(db, { workspaceId: s.workspace.id, actor: 'user', userId: s.user.id, action: 'api_token_revoked', detail: { id } })
  return { ok: true }
})
