import { eq } from 'drizzle-orm'
import { getHeader, getRequestIP, setHeader, type H3Event } from 'h3'
import { now } from '../clock'
import { config } from '../config'
import { schema, type Db } from '../db'
import { RateLimiter } from '../ratelimit'
import { logCall, type CallKey } from './call-log'
import { ACCESS_PREFIX, challengeHeader } from './oauth'
import { API_PER_MINUTE, apiLimiter, bearerOf, resolveBearer, type ApiPrincipal } from './principal'
import { API_TOKEN_PREFIX, hashSecret } from './tokens'

export const badTokenLimiter = new RateLimiter('api-bad-token', 30, 15 * 60_000)
export const registerLimiter = new RateLimiter('oauth-register', 20, 60 * 60_000)
export const tokenEndpointLimiter = new RateLimiter('oauth-token', 60, 60_000)

export function siteBase(): string {
  return config.appUrl
}

export function clientIp(event: H3Event): string {
  return getRequestIP(event, { xForwardedFor: config.trustProxy }) ?? 'unknown'
}

export function apiCors(event: H3Event, methods = 'GET, POST, PATCH, DELETE, OPTIONS') {
  setHeader(event, 'Access-Control-Allow-Origin', '*')
  setHeader(event, 'Access-Control-Allow-Methods', methods)
  setHeader(event, 'Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID')
  setHeader(event, 'Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate')
  setHeader(event, 'Access-Control-Max-Age', 86400)
}

export type AuthResult = { ok: true, principal: ApiPrincipal } | { ok: false, status: 401 | 429, message: string, retryAfter?: number }

// Abgelaufener, widerrufener oder getrennter Schlüssel, der noch bekannt ist: Ablehnung kommt ins Protokoll seines Arbeitsbereichs.
export async function deadKey(db: Db, token: string): Promise<{ key: CallKey, reason: string } | null> {
  if (token.length > 100) return null
  const hash = hashSecret(token)
  if (token.startsWith(API_TOKEN_PREFIX)) {
    const [t] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, hash))
    if (!t) return null
    return { key: { workspaceId: t.workspaceId, userId: t.userId, tokenId: t.id, label: t.name }, reason: t.revokedAt ? 'Schlüssel widerrufen' : t.expiresAt && t.expiresAt <= now() ? 'Schlüssel abgelaufen' : 'Kein Mitglied des Arbeitsbereichs mehr' }
  }
  if (token.startsWith(ACCESS_PREFIX)) {
    const [g] = await db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.accessHash, hash))
    if (!g) return null
    return { key: { workspaceId: g.workspaceId, userId: g.userId, grantId: g.id, label: g.clientName }, reason: 'Zugang abgelaufen' }
  }
  return null
}

export async function authenticate(db: Db, event: H3Event, via: 'mcp' | 'rest' = 'mcp'): Promise<AuthResult> {
  const ip = clientIp(event)
  const wait = await badTokenLimiter.retryAfter(db, ip)
  if (wait) return { ok: false, status: 429, message: 'Zu viele ungültige Tokens, später nochmal', retryAfter: wait }
  const token = bearerOf(getHeader(event, 'authorization'))
  if (!token) {
    setHeader(event, 'WWW-Authenticate', challengeHeader(siteBase()))
    return { ok: false, status: 401, message: 'Token fehlt (Authorization: Bearer ...)' }
  }
  const principal = await resolveBearer(db, token)
  if (!principal) {
    await badTokenLimiter.fail(db, ip)
    const dead = await deadKey(db, token).catch(() => null)
    if (dead) await logCall(db, dead.key, { via, tool: 'anmeldung', ok: false, denied: true, error: dead.reason, client: getHeader(event, 'user-agent') ?? null, ip })
    setHeader(event, 'WWW-Authenticate', challengeHeader(siteBase(), 'invalid_token'))
    return { ok: false, status: 401, message: 'Token ungültig, abgelaufen oder widerrufen' }
  }
  const limit = await apiLimiter.hit(db, principal.key)
  if (limit) {
    await logCall(db, principal, { via, tool: 'anmeldung', ok: false, denied: true, error: `Grenze ${API_PER_MINUTE} Anfragen je Minute erreicht`, client: getHeader(event, 'user-agent') ?? null, ip })
    return { ok: false, status: 429, message: 'Zu viele Anfragen', retryAfter: limit }
  }
  return { ok: true, principal }
}
