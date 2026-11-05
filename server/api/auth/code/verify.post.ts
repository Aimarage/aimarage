import { clientIp } from '~~/server/lib/api/http'
import { firstWorkspace } from '~~/server/lib/auth'
import { AuthError, verifyLoginCode } from '~~/server/lib/auth-codes'
import { getDb } from '~~/server/lib/db'
import { shouldOfferPasskey } from '~~/server/lib/webauthn'

const body = z.object({
  email: z.string().trim().min(3).max(254),
  code: z.string().trim().min(1).max(20),
})

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, body)
  const db = await getDb()
  return authGuard(event, async () => {
    const res = await verifyLoginCode(db, { email: input.email, code: input.code, ip: clientIp(event) })
    if (res.kind === 'register') return { ok: true, needsSignup: true, signupToken: res.token }
    const workspaceId = await firstWorkspace(db, res.user.id)
    if (!workspaceId) throw new AuthError(403, 'Zu diesem Konto gibt es keinen Arbeitsbereich')
    await startSession(event, db, res.user.id, workspaceId, 'code')
    return { ok: true, passkeyOffer: await shouldOfferPasskey(db, res.user) }
  })
})
