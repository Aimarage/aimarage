import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { siteBase } from '~~/server/lib/api/http'
import { checkAuthorize, OAuthError, redirectWith } from '~~/server/lib/api/oauth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const s = await requireAuth(event)
  const parsed = authorizeParams.safeParse(getQuery(event))
  if (!parsed.success) return { error: { code: 'invalid_request', message: 'Ungültige Anfrage' }, redirect: null }
  const base = siteBase()
  try {
    const req = await checkAuthorize(await getDb(), base, parsed.data)
    return {
      client: { name: req.client.name, redirectHost: hostOf(req.redirectUri), uri: req.client.clientUri },
      requested: req.requested,
      canWrite: roleAtLeast(s.role, 'member'),
      account: { name: s.user.name, email: s.user.email, workspace: s.workspace.name },
    }
  }
  catch (err) {
    if (!(err instanceof OAuthError)) throw err
    return { error: { code: err.code, message: err.message }, redirect: err.redirectUri ? redirectWith(err.redirectUri, { error: err.code, error_description: err.message, state: err.state, iss: base }) : null }
  }
})
