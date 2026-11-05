import { getDb } from '~~/server/lib/db'
import { apiCors, clientIp, siteBase, tokenEndpointLimiter } from '~~/server/lib/api/http'
import { exchangeCode, OAuthError, refreshGrant } from '~~/server/lib/api/oauth'
import { loadMember } from '~~/server/lib/api/principal'
import { oauthError, readOAuthBody } from '~~/server/utils/oauth'

export default defineEventHandler(async (event) => {
  apiCors(event, 'POST, OPTIONS')
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Pragma', 'no-cache')
  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }
  if (event.method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  try {
    const ip = clientIp(event)
    const db = await getDb()
    if (await tokenEndpointLimiter.retryAfter(db, ip)) throw new OAuthError('temporarily_unavailable', 'Too many requests, try again later', 429)
    await tokenEndpointLimiter.fail(db, ip)
    const p = await readOAuthBody(event)
    if (p.grant_type === 'authorization_code') return await exchangeCode(db, siteBase(), p)
    if (p.grant_type === 'refresh_token') return await refreshGrant(db, p, async (u, w) => !!(await loadMember(db, u, w)))
    throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported')
  }
  catch (err) {
    return oauthError(event, err)
  }
})
