import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { siteBase } from '~~/server/lib/api/http'
import { checkAuthorize, issueCode, OAuthError, redirectWith } from '~~/server/lib/api/oauth'
import { logActivity } from '~~/server/lib/activity'

const body = authorizeParams.extend({ decision: z.enum(['approve', 'deny']), write: z.boolean().optional() })

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  const db = await getDb()
  const base = siteBase()
  let req
  try {
    req = await checkAuthorize(db, base, input)
  }
  catch (err) {
    if (!(err instanceof OAuthError)) throw err
    if (!err.redirectUri) throw createError({ statusCode: 400, statusMessage: err.message })
    return { redirect: redirectWith(err.redirectUri, { error: err.code, error_description: err.message, state: err.state, iss: base }) }
  }
  if (input.decision === 'deny') return { redirect: redirectWith(req.redirectUri, { error: 'access_denied', error_description: 'Zugriff abgelehnt', state: req.state, iss: base }) }
  const scope = input.write && req.requested === 'write' && roleAtLeast(s.role, 'member') ? 'write' : 'read'
  const code = await issueCode(db, req, s.user.id, s.workspace.id, scope)
  await logActivity(db, { workspaceId: s.workspace.id, actor: 'user', userId: s.user.id, action: 'api_connected', detail: { title: req.client.name, scope } })
  return { redirect: redirectWith(req.redirectUri, { code, state: req.state, iss: base }) }
})
