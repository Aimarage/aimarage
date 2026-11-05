import { eq } from 'drizzle-orm'
import { AuthError, checkCode, findUserByEmail, normalizeEmail } from '~~/server/lib/auth-codes'
import { now } from '~~/server/lib/clock'
import { getDb, isUniqueViolation, schema } from '~~/server/lib/db'
import { queueSystemMail } from '~~/server/lib/system-mail'

const body = z.object({ email: z.string().trim().min(3).max(254), code: z.string().trim().min(1).max(20) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  const db = await getDb()
  return authGuard(event, async () => {
    const email = normalizeEmail(input.email)
    await checkCode(db, 'email_change', email, input.code, s.user.id)
    const other = await findUserByEmail(db, email)
    if (other && other.id !== s.user.id) throw new AuthError(409, 'E-Mail wird schon verwendet')
    try {
      await db.update(schema.users).set({ email, emailVerifiedAt: now() }).where(eq(schema.users.id, s.user.id))
    }
    catch (err) {
      if (isUniqueViolation(err)) throw new AuthError(409, 'E-Mail wird schon verwendet')
      throw err
    }
    const old = s.user.email
    if (/@/.test(old)) {
      const en = s.user.locale === 'en'
      await queueSystemMail(db, old, 'generic-notice', {
        name: s.user.name,
        subject: en ? 'Your Aimarage email address was changed' : 'Deine E-Mail-Adresse bei Aimarage wurde geändert',
        body: en ? `Your account now uses ${email}. If that was not you, please contact us right away.` : `Dein Konto verwendet jetzt ${email}. Warst du das nicht, melde dich bitte sofort bei uns.`,
      }, s.user.locale).catch(() => false)
    }
    return { ok: true, email }
  })
})
