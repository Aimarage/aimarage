import type { H3Event } from 'h3'
import { clientIp } from '../lib/api/http'
import { getDb } from '../lib/db'
import { clientBadTokens, clientHits, resolveClientLink, type ResolvedClient } from '../services/client'

export async function clientGate(event: H3Event): Promise<ResolvedClient> {
  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const ip = clientIp(event)
  const db = await getDb()
  const wait = (await clientBadTokens.retryAfter(db, ip)) || (await clientHits.retryAfter(db, ip))
  if (wait) {
    setResponseHeader(event, 'Retry-After', wait)
    throw createError({ statusCode: 429, statusMessage: 'Zu viele Anfragen, bitte später erneut' })
  }
  await clientHits.fail(db, ip)
  const c = await resolveClientLink(db, getRouterParam(event, 'token') ?? '')
  if (!c) {
    await clientBadTokens.fail(db, ip)
    throw createError({ statusCode: 404, statusMessage: 'Link ungültig oder abgelaufen' })
  }
  return c
}
