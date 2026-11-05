import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { and, eq, gt, lt, ne, sql } from 'drizzle-orm'
import type { Role } from '../../shared/utils/domain'
import type { SessionClient, SessionMethod } from '../db/schema'
import { config } from './config'
import type { DbOrTx } from './db'
import { schema } from './db'
import { now } from './clock'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

export const SESSION_COOKIE = 'ma_session'

let dummyHash: Promise<string> | null = null

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(pw, salt, 32)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function checkPasswordTimed(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    await verifyPassword(pw, await (dummyHash ??= hashPassword('-')))
    return false
  }
  return verifyPassword(pw, stored)
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false
  const [algo, saltB64, keyB64] = stored.split('$')
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length)
  return timingSafeEqual(key, expected)
}

export const STEP_UP_MINUTES = 10
// App-Geräte bleiben angemeldet, solange sie benutzt werden: jede Nutzung verlängert auf 365 Tage.
export const APP_SESSION_DAYS = 365
export const APP_TOKEN_PREFIX = 'ama_'
const LAST_SEEN_EVERY_MS = 5 * 60_000

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface SessionMeta {
  method?: SessionMethod
  userAgent?: string
  stepUpAt?: Date | null
  client?: SessionClient
  deviceName?: string
}

export async function createSession(db: DbOrTx, userId: string, workspaceId: string, meta: SessionMeta = {}): Promise<string> {
  const client = meta.client ?? 'web'
  const token = `${client === 'app' ? APP_TOKEN_PREFIX : ''}${randomBytes(32).toString('base64url')}`
  const at = now()
  const expiresAt = new Date(Date.now() + (client === 'app' ? APP_SESSION_DAYS : config.sessionDays) * 86_400_000)
  const method = meta.method ?? 'password'
  await db.insert(schema.sessions).values({
    client,
    deviceName: (meta.deviceName ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80),
    id: tokenHash(token),
    userId,
    workspaceId,
    expiresAt,
    method,
    userAgent: (meta.userAgent ?? '').slice(0, 300),
    lastSeenAt: new Date(),
    stepUpAt: client === 'app' ? null : meta.stepUpAt !== undefined ? meta.stepUpAt : method === 'password' ? null : at,
  })
  return token
}

export async function firstWorkspace(db: DbOrTx, userId: string): Promise<string | null> {
  const [m] = await db.select({ workspaceId: schema.memberships.workspaceId }).from(schema.memberships).where(eq(schema.memberships.userId, userId)).orderBy(schema.memberships.createdAt).limit(1)
  return m?.workspaceId ?? null
}

export function hasStepUp(s: SessionInfo, at = now()): boolean {
  const t = s.session?.stepUpAt
  return !!t && at.getTime() - new Date(t).getTime() < STEP_UP_MINUTES * 60_000
}

// Bestätigung per Passkey hebt die Sitzung auf eine Passkey-Sitzung an (wie eine Anmeldung mit Passkey).
export async function markStepUp(db: DbOrTx, sessionId: string, viaPasskey = false): Promise<void> {
  await db.update(schema.sessions).set({ stepUpAt: now(), ...(viaPasskey ? { method: 'passkey' as const } : {}) }).where(eq(schema.sessions.id, sessionId))
}

export async function listSessions(db: DbOrTx, userId: string) {
  return db.select({ id: schema.sessions.id, method: schema.sessions.method, client: schema.sessions.client, deviceName: schema.sessions.deviceName, push: sql<boolean>`exists (select 1 from app_devices d where d.session_id = "sessions"."id")`, userAgent: schema.sessions.userAgent, createdAt: schema.sessions.createdAt, lastSeenAt: schema.sessions.lastSeenAt, workspaceId: schema.sessions.workspaceId })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, sql`now()`)))
    .orderBy(sql`${schema.sessions.lastSeenAt} desc`)
}

export async function revokeSession(db: DbOrTx, userId: string, sessionId: string): Promise<boolean> {
  const rows = await db.delete(schema.sessions).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId))).returning({ id: schema.sessions.id })
  return rows.length > 0
}

export async function revokeOtherSessions(db: DbOrTx, userId: string, keepId: string | null): Promise<number> {
  const rows = await db.delete(schema.sessions).where(keepId ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepId)) : eq(schema.sessions.userId, userId)).returning({ id: schema.sessions.id })
  return rows.length
}

export async function pruneSessions(db: DbOrTx): Promise<void> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, sql`now()`))
}

export async function deleteSession(db: DbOrTx, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, tokenHash(token)))
}

export interface SessionInfo {
  user: typeof schema.users.$inferSelect
  workspace: typeof schema.workspaces.$inferSelect
  role: Role
  session?: { id: string, method: SessionMethod, stepUpAt: Date | null, client?: SessionClient }
}

// client: Web-Cookies und App-Tokens gelten nur dort, wofür sie ausgestellt wurden.
export async function resolveSession(db: DbOrTx, token: string | undefined, client: SessionClient = 'web'): Promise<SessionInfo | null> {
  if (!token) return null
  if (client === 'app' && !token.startsWith(APP_TOKEN_PREFIX)) return null
  const id = tokenHash(token)
  const rows = await db.select({ user: schema.users, workspace: schema.workspaces, role: schema.memberships.role, method: schema.sessions.method, stepUpAt: schema.sessions.stepUpAt, lastSeenAt: schema.sessions.lastSeenAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.sessions.workspaceId))
    .innerJoin(schema.memberships, and(eq(schema.memberships.userId, schema.users.id), eq(schema.memberships.workspaceId, schema.workspaces.id)))
    .where(and(eq(schema.sessions.id, id), eq(schema.sessions.client, client), gt(schema.sessions.expiresAt, sql`now()`)))
    .limit(1)
  const r = rows[0]
  if (!r) return null
  if (Date.now() - new Date(r.lastSeenAt).getTime() > LAST_SEEN_EVERY_MS) {
    await db.update(schema.sessions).set({ lastSeenAt: new Date(), ...(client === 'app' ? { expiresAt: new Date(Date.now() + APP_SESSION_DAYS * 86_400_000) } : {}) }).where(eq(schema.sessions.id, id))
  }
  return { user: r.user, workspace: r.workspace, role: r.role, session: { id, method: r.method, stepUpAt: client === 'app' ? null : r.stepUpAt, client } }
}

export async function login(db: DbOrTx, email: string, password: string, meta: SessionMeta = {}): Promise<{ token: string, userId: string, workspaceId: string } | null> {
  const [user] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email.trim().toLowerCase()}`)
  if (!user?.passwordHash) {
    await verifyPassword(password, await (dummyHash ??= hashPassword('-')))
    return null
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null
  const workspaceId = await firstWorkspace(db, user.id)
  if (!workspaceId) return null
  await db.update(schema.users).set({ lastLoginAt: now() }).where(eq(schema.users.id, user.id))
  return { token: await createSession(db, user.id, workspaceId, { ...meta, method: 'password' }), userId: user.id, workspaceId }
}
