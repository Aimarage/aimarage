import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { cleanPerms, scopeOfPerms, TOKEN_DAYS, TOKEN_DAYS_DEFAULT, TOKEN_WARN_DAYS, type ApiPerm } from '../../../shared/utils/api-perms'
import type { ApiScope } from '../../db/schema'
import { now } from '../clock'
import type { DbOrTx } from '../db'
import { schema } from '../db'

export const API_TOKEN_PREFIX = 'amk_'
export const MAX_TOKENS_PER_USER = 20

export function hashSecret(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newSecret(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function cleanLabel(v: unknown, fallback: string, max = 60): string {
  const s = typeof v === 'string' ? v.replace(/[\x00-\x1F\x7F<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
  return s || fallback
}

export class TokenLimitError extends Error {}

export function tokenDays(v: unknown): number {
  return (TOKEN_DAYS as readonly number[]).includes(Number(v)) ? Number(v) : TOKEN_DAYS_DEFAULT
}

function cleanProjects(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))]
  return ids.length ? ids.slice(0, 100) : null
}

export interface TokenInput {
  userId: string
  workspaceId: string
  name: string
  scope?: ApiScope
  canApprove?: boolean
  perms?: ApiPerm[]
  projectIds?: string[] | null
  days?: number
}

export async function createApiToken(db: DbOrTx, input: TokenInput): Promise<{ id: string, token: string, expiresAt: string }> {
  const active = await db.select({ id: schema.apiTokens.id }).from(schema.apiTokens).where(and(eq(schema.apiTokens.userId, input.userId), isNull(schema.apiTokens.revokedAt)))
  if (active.length >= MAX_TOKENS_PER_USER) throw new TokenLimitError(`Höchstens ${MAX_TOKENS_PER_USER} aktive Tokens`)
  const perms = input.perms ? cleanPerms(input.perms) : cleanPerms(input.scope === 'write' ? ['draft', 'strategy', 'agent', 'private', ...(input.canApprove ? ['approve'] : [])] : ['private'])
  const token = newSecret(API_TOKEN_PREFIX)
  const expiresAt = new Date(now().getTime() + tokenDays(input.days) * 86_400_000)
  const [row] = await db.insert(schema.apiTokens).values({
    userId: input.userId,
    workspaceId: input.workspaceId,
    name: cleanLabel(input.name, 'API-Token'),
    hint: token.slice(-4),
    tokenHash: hashSecret(token),
    scope: scopeOfPerms(perms),
    canApprove: perms.includes('approve'),
    perms,
    projectIds: cleanProjects(input.projectIds),
    expiresAt,
  }).returning({ id: schema.apiTokens.id })
  return { id: row!.id, token, expiresAt: expiresAt.toISOString() }
}

type TokenRow = typeof schema.apiTokens.$inferSelect

export function tokenView(r: TokenRow, owner?: string | null) {
  return {
    id: r.id,
    name: r.name,
    hint: r.hint,
    scope: r.scope,
    canApprove: r.canApprove,
    perms: cleanPerms(r.perms),
    projectIds: r.projectIds ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    reviewNeeded: r.reviewNeeded,
    lastClient: r.lastClient,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    ...(owner !== undefined ? { owner } : {}),
  }
}

const live = () => and(isNull(schema.apiTokens.revokedAt), or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, now())))

export async function listApiTokens(db: DbOrTx, userId: string, workspaceId: string) {
  const rows = await db.select().from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), eq(schema.apiTokens.workspaceId, workspaceId), live()))
    .orderBy(desc(schema.apiTokens.createdAt))
  return rows.map(r => tokenView(r))
}

// Für Inhaber und Admins: Schlüssel der anderen Mitglieder, damit sie sie sehen und widerrufen können.
export async function listOtherTokens(db: DbOrTx, userId: string, workspaceId: string) {
  const rows = await db.select({ t: schema.apiTokens, owner: schema.users.name }).from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(and(eq(schema.apiTokens.workspaceId, workspaceId), sql`${schema.apiTokens.userId} <> ${userId}`, live()))
    .orderBy(desc(schema.apiTokens.createdAt))
  return rows.map(r => tokenView(r.t, r.owner))
}

export async function revokeApiToken(db: DbOrTx, userId: string, id: string, opts: { workspaceId?: string, admin?: boolean } = {}): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false
  const who = opts.admin && opts.workspaceId ? eq(schema.apiTokens.workspaceId, opts.workspaceId) : eq(schema.apiTokens.userId, userId)
  const rows = await db.update(schema.apiTokens).set({ revokedAt: now() })
    .where(and(eq(schema.apiTokens.id, id), who, isNull(schema.apiTokens.revokedAt)))
    .returning({ id: schema.apiTokens.id })
  return rows.length > 0
}

export interface TokenPatch {
  perms?: ApiPerm[]
  projectIds?: string[] | null
  extendDays?: number
  name?: string
}

// Rechte, Projekte oder Laufzeit ändern; damit ist auch die Prüfung der übernommenen Rechte erledigt.
export async function updateApiToken(db: DbOrTx, userId: string, id: string, patch: TokenPatch) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const [cur] = await db.select().from(schema.apiTokens).where(and(eq(schema.apiTokens.id, id), eq(schema.apiTokens.userId, userId), live()))
  if (!cur) return null
  const set: Partial<TokenRow> = { reviewNeeded: false }
  if (patch.perms) {
    const perms = cleanPerms(patch.perms)
    Object.assign(set, { perms, scope: scopeOfPerms(perms), canApprove: perms.includes('approve') })
  }
  if (patch.projectIds !== undefined) set.projectIds = cleanProjects(patch.projectIds)
  if (patch.extendDays) {
    set.expiresAt = new Date(now().getTime() + tokenDays(patch.extendDays) * 86_400_000)
    set.expiryWarnedAt = null
  }
  if (patch.name) set.name = cleanLabel(patch.name, cur.name)
  const [row] = await db.update(schema.apiTokens).set(set).where(eq(schema.apiTokens.id, id)).returning()
  return row ? tokenView(row) : null
}

export async function findApiToken(db: DbOrTx, token: string) {
  if (!token.startsWith(API_TOKEN_PREFIX) || token.length > 100) return null
  const [row] = await db.select().from(schema.apiTokens).where(and(eq(schema.apiTokens.tokenHash, hashSecret(token)), live()))
  if (!row) return null
  if (!row.lastUsedAt || now().getTime() - row.lastUsedAt.getTime() > 5 * 60_000) await db.update(schema.apiTokens).set({ lastUsedAt: now() }).where(eq(schema.apiTokens.id, row.id))
  return row
}

export async function noteClient(db: DbOrTx, tokenId: string, client: string | null, onlyIfEmpty = false): Promise<void> {
  const c = client ? cleanLabel(client, '', 120) : ''
  if (!c) return
  const cond = onlyIfEmpty ? isNull(schema.apiTokens.lastClient) : or(isNull(schema.apiTokens.lastClient), sql`${schema.apiTokens.lastClient} <> ${c}`)
  await db.update(schema.apiTokens).set({ lastClient: c }).where(and(eq(schema.apiTokens.id, tokenId), cond))
}

// Schlüssel, die in den nächsten Tagen ablaufen und noch nicht gemeldet wurden.
export async function expiringTokens(db: DbOrTx, at = now()) {
  const until = new Date(at.getTime() + TOKEN_WARN_DAYS * 86_400_000)
  return db.select().from(schema.apiTokens).where(and(isNull(schema.apiTokens.revokedAt), isNotNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, at), lt(schema.apiTokens.expiresAt, until), isNull(schema.apiTokens.expiryWarnedAt)))
}
