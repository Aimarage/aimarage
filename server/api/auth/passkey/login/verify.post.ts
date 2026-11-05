import { firstWorkspace } from '~~/server/lib/auth'
import { AuthError } from '~~/server/lib/auth-codes'
import { getDb } from '~~/server/lib/db'
import { verifyPasskeyLogin } from '~~/server/lib/webauthn'

const body = z.object({
  challengeId: z.string().max(64),
  response: z.looseObject({ id: z.string().max(1024) }),
})

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, body)
  const db = await getDb()
  return authGuard(event, async () => {
    const user = await verifyPasskeyLogin(db, input.challengeId, input.response as never)
    const workspaceId = await firstWorkspace(db, user.id)
    if (!workspaceId) throw new AuthError(403, 'Zu diesem Konto gibt es keinen Arbeitsbereich')
    await startSession(event, db, user.id, workspaceId, 'passkey')
    return { ok: true }
  })
})
