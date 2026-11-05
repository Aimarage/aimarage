import { getDb } from '~~/server/lib/db'
import { verifyPasskeyRegistration } from '~~/server/lib/webauthn'

const body = z.object({
  challengeId: z.string().max(64),
  response: z.looseObject({ id: z.string().max(1024) }),
  name: z.string().trim().max(60).default(''),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  const db = await getDb()
  const row = await authGuard(event, () => verifyPasskeyRegistration(db, s.user.id, input.challengeId, input.response as never, input.name))
  return { ok: true, passkey: { id: row.id, name: row.name } }
})
