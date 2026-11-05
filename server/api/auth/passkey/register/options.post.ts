import { getDb } from '~~/server/lib/db'
import { passkeyRegistrationOptions } from '~~/server/lib/webauthn'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  requireStepUp(s)
  const db = await getDb()
  return authGuard(event, () => passkeyRegistrationOptions(db, s.user))
})
