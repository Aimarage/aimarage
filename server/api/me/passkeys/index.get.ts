import { getDb } from '~~/server/lib/db'
import { listPasskeys } from '~~/server/lib/webauthn'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  return { passkeys: await listPasskeys(await getDb(), s.user.id) }
})
