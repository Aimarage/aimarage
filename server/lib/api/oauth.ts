import { createHash } from 'node:crypto'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { ApiScope } from '../../db/schema'
import type { Db, DbOrTx } from '../db'
import { schema } from '../db'
import { cleanLabel, hashSecret, newSecret } from './tokens'

export const CODE_TTL_S = 5 * 60
export const ACCESS_TTL_S = 60 * 60
export const REFRESH_TTL_S = 30 * 86_400
export const OAUTH_SCOPES: ApiScope[] = ['read', 'write']
export const ACCESS_PREFIX = 'amo_'

export function mcpResource(base: string): string {
  return `${base}/mcp`
}

export function resourceMetadataUrl(base: string): string {
  return `${base}/.well-known/oauth-protected-resource/mcp`
}

export function resourceOk(base: string, resource: string | undefined | null): boolean {
  const r = (resource ?? '').replace(/\/+$/, '')
  return !r || r === mcpResource(base) || r === base
}

export class OAuthError extends Error {
  redirectUri: string | null = null
  state: string | null = null
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message)
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function validRedirectUri(raw: string): boolean {
  if (raw.length > 500) return false
  let u: URL
  try {
    u = new URL(raw)
  }
  catch {
    return false
  }
  if (u.hash || u.username || u.password) return false
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname)
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(u.protocol)
}

export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true
  let g: URL
  try {
    g = new URL(given)
  }
  catch {
    return false
  }
  if (g.protocol !== 'http:' || !LOOPBACK.has(g.hostname)) return false
  return registered.some((r) => {
    try {
      const u = new URL(r)
      return u.protocol === 'http:' && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search
    }
    catch {
      return false
    }
  })
}

export async function registerClient(db: DbOrTx, input: Record<string, unknown>) {
  const raw = input.redirect_uris
  const uris = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === 'string') : []
  if (!uris.length || uris.length > 10 || uris.length !== (raw as unknown[]).length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a list of 1 to 10 URLs')
  for (const u of uris) if (!validRedirectUri(u)) throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${u.slice(0, 100)}`)
  const grants = Array.isArray(input.grant_types) ? input.grant_types : ['authorization_code', 'refresh_token']
  if (!grants.every(g => g === 'authorization_code' || g === 'refresh_token')) throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token are supported')
  const responses = Array.isArray(input.response_types) ? input.response_types : ['code']
  if (!responses.every(r => r === 'code')) throw new OAuthError('invalid_client_metadata', 'Only response_type code is supported')
  if ((input.token_endpoint_auth_method ?? 'none') !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method none) are supported')
  const clientUri = typeof input.client_uri === 'string' && /^https:\/\/\S{1,200}$/.test(input.client_uri) ? input.client_uri : null
  const id = newSecret('amc_').slice(0, 36)
  const [row] = await db.insert(schema.oauthClients).values({ id, name: cleanLabel(input.client_name, 'MCP-Client'), redirectUris: uris, clientUri }).returning()
  return {
    client_id: row!.id,
    client_id_issued_at: Math.floor(row!.createdAt.getTime() / 1000),
    client_name: row!.name,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

export function scopeOf(raw: unknown, fallback: ApiScope = 'read'): ApiScope {
  const set = new Set(typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : [])
  if (!set.size) return fallback
  return set.has('write') ? 'write' : 'read'
}

export function scopeString(scope: ApiScope): string {
  return scope === 'write' ? 'read write' : 'read'
}

export interface AuthorizeParams {
  response_type?: string
  client_id?: string
  redirect_uri?: string
  code_challenge?: string
  code_challenge_method?: string
  scope?: string
  state?: string
  resource?: string
}

export interface AuthorizeRequest {
  client: typeof schema.oauthClients.$inferSelect
  redirectUri: string
  codeChallenge: string
  requested: ApiScope
  state: string | null
}

export async function checkAuthorize(db: DbOrTx, base: string, p: AuthorizeParams): Promise<AuthorizeRequest> {
  const [client] = p.client_id ? await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, String(p.client_id).slice(0, 64))) : []
  if (!client) throw new OAuthError('invalid_client', 'Unbekannte App. Bitte in der KI-App neu verbinden.')
  const redirectUri = String(p.redirect_uri ?? '')
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) throw new OAuthError('invalid_request', 'Die Rücksprung-Adresse dieser App ist nicht registriert.')
  const state = typeof p.state === 'string' ? p.state.slice(0, 500) : null
  const redirectable = (code: string, msg: string) => {
    const e = new OAuthError(code, msg)
    e.redirectUri = redirectUri
    e.state = state
    return e
  }
  if (p.response_type !== 'code') throw redirectable('unsupported_response_type', 'Only response_type=code is supported')
  if (p.code_challenge_method !== 'S256' || !p.code_challenge || !/^[\w-]{43,128}$/.test(p.code_challenge)) throw redirectable('invalid_request', 'PKCE with S256 is required')
  if (!resourceOk(base, p.resource)) throw redirectable('invalid_target', 'Unknown resource')
  return { client, redirectUri, codeChallenge: p.code_challenge, requested: scopeOf(p.scope, 'write'), state }
}

export function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v)
  return u.toString()
}

export async function issueCode(db: DbOrTx, req: AuthorizeRequest, userId: string, workspaceId: string, scope: ApiScope): Promise<string> {
  const code = newSecret('amz_')
  await db.insert(schema.oauthCodes).values({
    codeHash: hashSecret(code),
    clientId: req.client.id,
    userId,
    workspaceId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    scope,
    expiresAt: new Date(Date.now() + CODE_TTL_S * 1000),
  })
  return code
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export async function exchangeCode(db: Db, base: string, p: Record<string, string | undefined>): Promise<TokenResponse> {
  if (!p.code || !p.code_verifier || !p.client_id || !p.redirect_uri) throw new OAuthError('invalid_request', 'code, code_verifier, client_id and redirect_uri are required')
  const [row] = await db.delete(schema.oauthCodes).where(eq(schema.oauthCodes.codeHash, hashSecret(p.code))).returning()
  if (!row || row.expiresAt.getTime() < Date.now()) throw new OAuthError('invalid_grant', 'Code is invalid or expired')
  if (row.clientId !== p.client_id || row.redirectUri !== p.redirect_uri) throw new OAuthError('invalid_grant', 'Code was issued to another client')
  if (!/^[\w.~-]{43,128}$/.test(p.code_verifier) || pkceChallenge(p.code_verifier) !== row.codeChallenge) throw new OAuthError('invalid_grant', 'PKCE verification failed')
  if (!resourceOk(base, p.resource)) throw new OAuthError('invalid_target', 'Unknown resource')
  const [client] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, row.clientId))
  if (!client) throw new OAuthError('invalid_client', 'Unknown client')
  const access = newSecret(ACCESS_PREFIX)
  const refresh = newSecret('amr_')
  const t = Date.now()
  await db.transaction(async (tx) => {
    await tx.delete(schema.oauthGrants).where(and(eq(schema.oauthGrants.userId, row.userId), eq(schema.oauthGrants.clientId, row.clientId), eq(schema.oauthGrants.workspaceId, row.workspaceId)))
    await tx.insert(schema.oauthGrants).values({
      userId: row.userId,
      workspaceId: row.workspaceId,
      clientId: row.clientId,
      clientName: client.name,
      scope: row.scope,
      accessHash: hashSecret(access),
      accessExpiresAt: new Date(t + ACCESS_TTL_S * 1000),
      refreshHash: hashSecret(refresh),
      refreshExpiresAt: new Date(t + REFRESH_TTL_S * 1000),
      lastUsedAt: new Date(t),
    })
    await tx.update(schema.oauthClients).set({ lastUsedAt: new Date(t) }).where(eq(schema.oauthClients.id, row.clientId))
  })
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopeString(row.scope) }
}

export async function refreshGrant(db: Db, p: Record<string, string | undefined>, stillMember: (userId: string, workspaceId: string) => Promise<boolean>): Promise<TokenResponse> {
  if (!p.refresh_token || !p.client_id) throw new OAuthError('invalid_request', 'refresh_token and client_id are required')
  const hash = hashSecret(p.refresh_token)
  const [grant] = await db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.refreshHash, hash))
  if (!grant) {
    await db.delete(schema.oauthGrants).where(eq(schema.oauthGrants.prevRefreshHash, hash))
    throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired')
  }
  if (grant.clientId !== p.client_id) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client')
  if (grant.refreshExpiresAt.getTime() < Date.now() || !(await stillMember(grant.userId, grant.workspaceId))) {
    await db.delete(schema.oauthGrants).where(eq(schema.oauthGrants.id, grant.id))
    throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired')
  }
  const scope: ApiScope = p.scope && grant.scope === 'write' ? scopeOf(p.scope) : grant.scope
  const access = newSecret(ACCESS_PREFIX)
  const refresh = newSecret('amr_')
  const t = Date.now()
  const rows = await db.update(schema.oauthGrants).set({
    scope,
    accessHash: hashSecret(access),
    accessExpiresAt: new Date(t + ACCESS_TTL_S * 1000),
    refreshHash: hashSecret(refresh),
    prevRefreshHash: hash,
    refreshExpiresAt: new Date(t + REFRESH_TTL_S * 1000),
    lastUsedAt: new Date(t),
  }).where(and(eq(schema.oauthGrants.id, grant.id), eq(schema.oauthGrants.refreshHash, hash))).returning({ id: schema.oauthGrants.id })
  if (!rows.length) throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired')
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopeString(scope) }
}

export async function findGrant(db: DbOrTx, token: string) {
  if (!token.startsWith(ACCESS_PREFIX) || token.length > 100) return null
  const [g] = await db.select().from(schema.oauthGrants).where(and(eq(schema.oauthGrants.accessHash, hashSecret(token)), gt(schema.oauthGrants.accessExpiresAt, sql`now()`)))
  if (!g) return null
  if (!g.lastUsedAt || Date.now() - g.lastUsedAt.getTime() > 5 * 60_000) await db.update(schema.oauthGrants).set({ lastUsedAt: new Date() }).where(eq(schema.oauthGrants.id, g.id))
  return g
}

export async function revokeToken(db: DbOrTx, token: string): Promise<void> {
  const hash = hashSecret(token)
  await db.delete(schema.oauthGrants).where(sql`${schema.oauthGrants.accessHash} = ${hash} or ${schema.oauthGrants.refreshHash} = ${hash}`)
}

export async function listGrants(db: DbOrTx, userId: string, workspaceId: string) {
  const rows = await db.select().from(schema.oauthGrants).where(and(eq(schema.oauthGrants.userId, userId), eq(schema.oauthGrants.workspaceId, workspaceId), gt(schema.oauthGrants.refreshExpiresAt, sql`now()`)))
  return rows.map(g => ({ id: g.id, name: g.clientName, scope: g.scope, createdAt: g.createdAt.toISOString(), lastUsedAt: g.lastUsedAt?.toISOString() ?? null }))
}

export async function deleteGrant(db: DbOrTx, userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false
  const rows = await db.delete(schema.oauthGrants).where(and(eq(schema.oauthGrants.id, id), eq(schema.oauthGrants.userId, userId))).returning({ id: schema.oauthGrants.id })
  return rows.length > 0
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: OAUTH_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  }
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: mcpResource(base),
    resource_name: 'Aimarage',
    authorization_servers: [base],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
  }
}

export function challengeHeader(base: string, error?: 'invalid_token' | 'insufficient_scope'): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(base)}"`, `scope="${OAUTH_SCOPES.join(' ')}"`]
  if (error) parts.unshift(`error="${error}"`)
  return `Bearer ${parts.join(', ')}`
}
