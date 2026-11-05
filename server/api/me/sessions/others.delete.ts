import { revokeOtherSessions } from '~~/server/lib/auth'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const n = await revokeOtherSessions(await getDb(), s.user.id, s.session?.id ?? null)
  return { ok: true, revoked: n }
})
