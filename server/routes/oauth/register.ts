import { getDb } from '~~/server/lib/db'
import { apiCors, clientIp, registerLimiter } from '~~/server/lib/api/http'
import { OAuthError, registerClient } from '~~/server/lib/api/oauth'
import { oauthError } from '~~/server/utils/oauth'

export default defineEventHandler(async (event) => {
  apiCors(event, 'POST, OPTIONS')
  setHeader(event, 'Cache-Control', 'no-store')
  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }
  if (event.method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  try {
    const ip = clientIp(event)
    const db = await getDb()
    if (await registerLimiter.retryAfter(db, ip)) throw new OAuthError('temporarily_unavailable', 'Too many registrations, try again later', 429)
    await registerLimiter.fail(db, ip)
    if (Number(getHeader(event, 'content-length') ?? 0) > 16 * 1024) throw new OAuthError('invalid_client_metadata', 'Request too large', 413)
    const body = await readBody(event).catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'JSON body expected')
    const client = await registerClient(db, body as Record<string, unknown>)
    setResponseStatus(event, 201)
    return client
  }
  catch (err) {
    return oauthError(event, err)
  }
})
