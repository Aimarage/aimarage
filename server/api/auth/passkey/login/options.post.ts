import { clientIp } from '~~/server/lib/api/http'
import { limit, limits } from '~~/server/lib/auth-codes'
import { getDb } from '~~/server/lib/db'
import { passkeyLoginOptions } from '~~/server/lib/webauthn'

export default defineEventHandler(async (event) => {
  const db = await getDb()
  return authGuard(event, async () => {
    await limit(db, limits.verifyIp, `pk:${clientIp(event)}`)
    return passkeyLoginOptions(db)
  })
})
