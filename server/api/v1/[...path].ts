import type { H3Event } from 'h3'
import { getDb } from '~~/server/lib/db'
import { apiActor } from '~~/server/lib/api/principal'
import { apiCors, authenticate, clientIp, siteBase } from '~~/server/lib/api/http'
import { matchRoute, openApi, permOfRoute } from '~~/server/lib/api/rest'
import { logCall } from '~~/server/lib/api/call-log'
import { hasPerm } from '~~/shared/utils/api-perms'
import { redactPrivate, scrubSecrets } from '~~/shared/utils/private-data'
import { ApiError } from '~~/server/lib/api/service'
import { isLimitError, mcpAllowed } from '~~/server/lib/limits'

function fail(event: H3Event, status: number, message: string, data?: unknown) {
  setResponseStatus(event, status)
  return { error: message, ...(data ? { details: data } : {}) }
}

export default defineEventHandler(async (event) => {
  apiCors(event)
  setHeader(event, 'Cache-Control', 'no-store')
  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }
  const path = `/${getRouterParam(event, 'path') ?? ''}`.replace(/\/+$/, '') || '/'
  if (path === '/openapi.json' && event.method === 'GET') return openApi(siteBase())
  const db = await getDb()
  const auth = await authenticate(db, event, 'rest')
  if (!auth.ok) {
    if (auth.retryAfter) setHeader(event, 'Retry-After', auth.retryAfter)
    return fail(event, auth.status, auth.message)
  }
  const m = matchRoute(event.method, path)
  if (m === 'method') return fail(event, 405, 'Methode nicht erlaubt')
  if (!m) return fail(event, 404, 'Unbekannte Adresse, siehe /api/v1/openapi.json')
  if (m.route.scope === 'write' && auth.principal.scope !== 'write') {
    await logCall(db, auth.principal, { via: 'rest', tool: `${event.method} ${m.route.path}`, args: m.params, ok: false, denied: true, error: 'Token nur zum Lesen', client: getHeader(event, 'user-agent') ?? null, ip: clientIp(event) })
    return fail(event, 403, 'Token nur zum Lesen')
  }
  const perm = permOfRoute(m.route)
  if (!hasPerm(auth.principal.perms, perm)) {
    const msg = `Diesem Schlüssel fehlt das Recht "${perm}" (Einstellungen > API und MCP)`
    await logCall(db, auth.principal, { via: 'rest', tool: `${event.method} ${m.route.path}`, args: m.params, ok: false, denied: true, error: msg, client: getHeader(event, 'user-agent') ?? null, ip: clientIp(event) })
    return fail(event, 403, msg)
  }
  const q = m.route.query ? m.route.query.safeParse(getQuery(event)) : { success: true as const, data: {} }
  if (!q.success) return fail(event, 400, 'Ungültige Abfrage', q.error.issues)
  let body: Record<string, unknown> = {}
  if (m.route.body) {
    if (Number(getHeader(event, 'content-length') ?? 0) > 256 * 1024) return fail(event, 413, 'Anfrage zu groß')
    const raw = await readBody(event).catch(() => null)
    const b = m.route.body.safeParse(raw ?? {})
    if (!b.success) return fail(event, 400, 'Ungültige Eingabe', b.error.issues)
    body = b.data as Record<string, unknown>
  }
  const started = Date.now()
  const log = (ok: boolean, error: string | null, out?: unknown) => logCall(db, auth.principal, { via: 'rest', tool: `${event.method} ${m.route.path}`, args: { ...m.params, ...(q.data as Record<string, unknown>), ...body }, ok, error, resultBytes: out === undefined ? 0 : Buffer.byteLength(JSON.stringify(out) ?? ''), durationMs: Date.now() - started, client: getHeader(event, 'user-agent') ?? null, ip: clientIp(event) })
  try {
    const actor = await apiActor(db, auth.principal)
    if (!mcpAllowed(actor.workspace, m.route.scope === 'write' ? 'write' : 'read')) return fail(event, 402, 'API ist im aktuellen Tarif nicht enthalten', { code: 'limit', kind: 'mcp' })
    let out = scrubSecrets(await m.route.run({ db, actor, principal: auth.principal, params: m.params, query: q.data as Record<string, unknown>, body, deps: {} }))
    if (!hasPerm(auth.principal.perms, 'private')) out = redactPrivate(out)
    await log(true, null, out)
    return out
  }
  catch (err) {
    await log(false, (err as Error).message ?? 'Fehler')
    if (err instanceof ApiError) return fail(event, err.status, err.message)
    if (isLimitError(err)) return fail(event, 402, err.message, { code: 'limit', kind: err.kind })
    throw err
  }
})
