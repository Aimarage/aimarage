import { and, eq } from 'drizzle-orm'
import { legacyPerms, scopeOfPerms, cleanPerms, type ApiPerm } from '../../../shared/utils/api-perms'
import type { ApiScope } from '../../db/schema'
import { projectAccess, type Access } from '../access'
import type { SessionInfo } from '../auth'
import type { ChatActor } from '../chat'
import type { DbOrTx } from '../db'
import { schema } from '../db'
import { RateLimiter } from '../ratelimit'
import { findGrant } from './oauth'
import { findApiToken } from './tokens'

export interface ApiPrincipal {
  session: SessionInfo
  scope: ApiScope
  via: 'token' | 'oauth'
  label: string
  key: string
  canApprove?: boolean
  perms: ApiPerm[]
  projectIds?: string[] | null
  tokenId?: string | null
  grantId?: string | null
  expiresAt?: Date | null
  reviewNeeded?: boolean
}

export const API_PER_MINUTE = 240
export const apiLimiter = new RateLimiter('api', API_PER_MINUTE, 60_000)

export function bearerOf(header: string | undefined | null): string {
  const h = (header ?? '').trim()
  return /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, '').trim() : ''
}

export async function loadMember(db: DbOrTx, userId: string, workspaceId: string): Promise<SessionInfo | null> {
  const [row] = await db.select({ user: schema.users, workspace: schema.workspaces, role: schema.memberships.role })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId)))
  return row ?? null
}

export async function resolveBearer(db: DbOrTx, token: string): Promise<ApiPrincipal | null> {
  if (!token) return null
  const t = await findApiToken(db, token)
  if (t) {
    const session = await loadMember(db, t.userId, t.workspaceId)
    const perms = cleanPerms(t.perms)
    return session ? { session, scope: scopeOfPerms(perms), via: 'token', label: t.name, key: `t:${t.id}`, canApprove: perms.includes('approve'), perms, projectIds: t.projectIds ?? null, tokenId: t.id, expiresAt: t.expiresAt, reviewNeeded: t.reviewNeeded } : null
  }
  const g = await findGrant(db, token)
  if (g) {
    const session = await loadMember(db, g.userId, g.workspaceId)
    return session ? { session, scope: g.scope, via: 'oauth', label: g.clientName, key: `g:${g.id}`, perms: legacyPerms(g.scope), grantId: g.id, expiresAt: g.refreshExpiresAt } : null
  }
  return null
}

// Projekte des Schlüssels: Schnittmenge aus den Projekten der Person und den am Schlüssel eingestellten.
export function narrowAccess(a: Access, projectIds: string[] | null | undefined): Access {
  if (!projectIds?.length) return a
  return { all: false, ids: a.all ? [...projectIds] : a.ids.filter(id => projectIds.includes(id)) }
}

export async function apiActor(db: DbOrTx, p: ApiPrincipal): Promise<ChatActor> {
  const s = p.session
  const write = p.scope === 'write' && scopeOfPerms(p.perms) === 'write'
  return {
    workspace: s.workspace,
    userId: s.user.id,
    userName: s.user.name,
    role: write ? s.role : 'viewer',
    access: narrowAccess(await projectAccess(db, { workspaceId: s.workspace.id, userId: s.user.id, role: s.role }), p.projectIds),
    via: 'api',
    canApprove: write && p.via === 'token' && p.perms.includes('approve'),
    perms: p.perms,
  }
}
