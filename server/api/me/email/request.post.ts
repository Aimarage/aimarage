import { AuthError, findUserByEmail, normalizeEmail, requestUserCode } from '~~/server/lib/auth-codes'
import { getDb } from '~~/server/lib/db'

const body = z.object({ email: z.string().trim().min(3).max(254) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  const db = await getDb()
  return authGuard(event, async () => {
    const email = normalizeEmail(input.email)
    if (email === s.user.email.toLowerCase()) throw new AuthError(400, 'Das ist schon deine Adresse')
    requireStepUp(s)
    const other = await findUserByEmail(db, email)
    if (other && other.id !== s.user.id) throw new AuthError(409, 'E-Mail wird schon verwendet')
    await requestUserCode(db, 'email_change', s.user, email)
    return { ok: true }
  })
})
