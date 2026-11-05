import { checkPasswordTimed, markStepUp } from '~~/server/lib/auth'
import { AuthError, checkCode, requestUserCode } from '~~/server/lib/auth-codes'
import { config } from '~~/server/lib/config'
import { getDb } from '~~/server/lib/db'
import { loginLimiter } from '~~/server/lib/ratelimit'
import { passkeyLoginOptions, verifyPasskeyLogin } from '~~/server/lib/webauthn'

const body = z.discriminatedUnion('method', [
  z.object({ method: z.literal('code-request'), action: z.string().max(120).optional() }),
  z.object({ method: z.literal('code'), code: z.string().trim().min(1).max(20) }),
  z.object({ method: z.literal('passkey-options') }),
  z.object({ method: z.literal('passkey'), challengeId: z.string().max(64), response: z.looseObject({ id: z.string().max(1024) }) }),
  z.object({ method: z.literal('password'), password: z.string().min(1).max(500) }),
])

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  const db = await getDb()
  const sessionId = s.session?.id
  if (!sessionId) throw createError({ statusCode: 401, statusMessage: 'Nicht angemeldet' })
  return authGuard(event, async () => {
    switch (input.method) {
      case 'code-request':
        await requestUserCode(db, 'step_up', s.user, s.user.email.toLowerCase(), input.action)
        return { ok: true }
      case 'code':
        await checkCode(db, 'step_up', s.user.email.toLowerCase(), input.code, s.user.id)
        break
      case 'passkey-options':
        return passkeyLoginOptions(db, s.user.id, 'step_up')
      case 'passkey':
        await verifyPasskeyLogin(db, input.challengeId, input.response as never, s.user.id, 'step_up')
        break
      case 'password': {
        if (!config.authPassword) throw new AuthError(404, 'Passwort-Anmeldung ist ausgeschaltet')
        const key = `step-up:${s.user.id}`
        const wait = await loginLimiter.retryAfter(db, key)
        if (wait) throw new AuthError(429, 'Zu viele Versuche, bitte später erneut', wait)
        if (!(await checkPasswordTimed(input.password, s.user.passwordHash))) {
          await loginLimiter.fail(db, key)
          throw new AuthError(400, 'Passwort stimmt nicht')
        }
        await loginLimiter.reset(db, key)
        break
      }
    }
    await markStepUp(db, sessionId, input.method === 'passkey')
    return { ok: true, stepUp: true }
  })
})
