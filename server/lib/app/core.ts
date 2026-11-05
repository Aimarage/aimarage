import { and, eq, isNull } from 'drizzle-orm'
import { ALL_SLUG } from '../../../shared/utils/domain'
import { canSeeProject, projectAccess, type Access } from '../access'
import { createSession, firstWorkspace, login, tokenHash, type SessionInfo } from '../auth'
import { AuthError, verifyLoginCode } from '../auth-codes'
import type { ChatActor } from '../chat'
import type { Db, DbOrTx } from '../db'
import { schema } from '../db'
import { emitUserLoggedIn } from '../extensions'
import { verifyPasskeyLogin } from '../webauthn'

type Project = typeof schema.projects.$inferSelect

export class AppError extends Error {
  readonly appError = true
  constructor(public readonly status: number, message: string, public readonly data?: Record<string, unknown>) {
    super(message)
  }
}

export interface AppCtx {
  db: Db
  s: SessionInfo
  access: Access
}

export async function appCtx(db: Db, s: SessionInfo): Promise<AppCtx> {
  return { db, s, access: await projectAccess(db, { workspaceId: s.workspace.id, userId: s.user.id, role: s.role }, s) }
}

export function actorOf(c: AppCtx): ChatActor {
  return { workspace: c.s.workspace, userId: c.s.user.id, userName: c.s.user.name, locale: c.s.user.locale, role: c.s.role, access: c.access, client: 'app' }
}

export async function visibleProjects(c: AppCtx): Promise<Project[]> {
  const rows = await c.db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, c.s.workspace.id), isNull(schema.projects.archivedAt))).orderBy(schema.projects.sortOrder, schema.projects.name)
  return rows.filter(p => canSeeProject(c.access, p.id))
}

// Projektwahl der App: Kürzel (slug), leer oder "alle" = alle sichtbaren Projekte.
export async function projectOf(c: AppCtx, slug: string | null | undefined): Promise<Project | null> {
  if (!slug || slug === ALL_SLUG) return null
  const [p] = await c.db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, c.s.workspace.id), eq(schema.projects.slug, slug)))
  if (!p || !canSeeProject(c.access, p.id)) throw new AppError(404, 'Projekt nicht gefunden')
  return p
}

export interface AppLogin {
  token: string
  user: { id: string, name: string, email: string, locale: string }
  workspace: { id: string, name: string }
}

async function issue(db: Db, user: typeof schema.users.$inferSelect, method: 'code' | 'passkey', meta: { deviceName?: string, userAgent?: string }, workspaceId?: string | null): Promise<AppLogin> {
  const wsId = workspaceId ?? await firstWorkspace(db, user.id)
  if (!wsId) throw new AuthError(403, 'Zu diesem Konto gibt es keinen Arbeitsbereich')
  const [ws] = await db.select({ id: schema.workspaces.id, name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, wsId))
  const token = await createSession(db, user.id, wsId, { method, client: 'app', deviceName: meta.deviceName, userAgent: meta.userAgent })
  await emitUserLoggedIn(db, { userId: user.id, workspaceId: wsId })
  return { token, user: { id: user.id, name: user.name, email: user.email, locale: user.locale }, workspace: ws! }
}

// Passwort wie im Web (nur wo die Passwort-Anmeldung eingeschaltet ist, z.B. lokal).
export async function appLoginByPassword(db: Db, input: { email: string, password: string, deviceName?: string, userAgent?: string }): Promise<AppLogin | null> {
  const res = await login(db, input.email, input.password, { client: 'app', deviceName: input.deviceName, userAgent: input.userAgent })
  if (!res) return null
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, res.userId))
  const [ws] = await db.select({ id: schema.workspaces.id, name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, res.workspaceId))
  await emitUserLoggedIn(db, { userId: res.userId, workspaceId: res.workspaceId })
  return { token: res.token, user: { id: user!.id, name: user!.name, email: user!.email, locale: user!.locale }, workspace: ws! }
}

// Mail-Code wie im Web (gleiche Grenzen); neue Konten registrieren sich im Web.
export async function appLoginByCode(db: Db, input: { email: string, code: string, ip: string, deviceName?: string, userAgent?: string }): Promise<AppLogin> {
  const res = await verifyLoginCode(db, { email: input.email, code: input.code, ip: input.ip })
  if (res.kind === 'register') throw new AuthError(409, 'Zu dieser Adresse gibt es kein Konto.', undefined, { noAccount: true })
  return issue(db, res.user, 'code', input)
}

export async function appLoginByPasskey(db: Db, input: { challengeId: string, response: unknown, deviceName?: string, userAgent?: string }): Promise<AppLogin> {
  const user = await verifyPasskeyLogin(db, input.challengeId, input.response as never)
  return issue(db, user, 'passkey', input)
}

// Arbeitsbereich wechseln: neues Geräte-Token, das alte wird gelöscht (Push-Anmeldung zieht mit).
export async function appSwitchWorkspace(db: Db, s: SessionInfo, workspaceId: string, meta: { deviceName?: string, userAgent?: string }): Promise<AppLogin> {
  const [m] = await db.select({ workspaceId: schema.memberships.workspaceId }).from(schema.memberships)
    .where(and(eq(schema.memberships.userId, s.user.id), eq(schema.memberships.workspaceId, workspaceId)))
  if (!m) throw new AppError(404, 'Arbeitsbereich nicht gefunden')
  const [old] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, s.session!.id))
  const [push] = await db.select().from(schema.appDevices).where(eq(schema.appDevices.sessionId, s.session!.id))
  const next = await issue(db, s.user, s.session!.method === 'passkey' ? 'passkey' : 'code', { deviceName: meta.deviceName ?? old?.deviceName, userAgent: meta.userAgent ?? old?.userAgent }, workspaceId)
  await db.delete(schema.sessions).where(eq(schema.sessions.id, s.session!.id))
  if (push) await registerPush(db, { ...s, workspace: { ...s.workspace, id: workspaceId }, session: { ...s.session!, id: tokenHash(next.token) } }, { token: push.pushToken, env: push.pushEnv, locale: push.locale })
  return next
}

export async function appLogout(db: DbOrTx, s: SessionInfo): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, s.session!.id))
}

export const PUSH_TOKEN_RE = /^[0-9a-f]{32,200}$/i

export async function registerPush(db: DbOrTx, s: SessionInfo, input: { token: string, env?: 'production' | 'sandbox' | null, locale?: string | null }): Promise<void> {
  const token = input.token.trim().toLowerCase()
  if (!PUSH_TOKEN_RE.test(token)) throw new AppError(400, 'Push-Token ungültig')
  const values = { sessionId: s.session!.id, userId: s.user.id, workspaceId: s.workspace.id, pushToken: token, pushEnv: input.env === 'sandbox' ? 'sandbox' as const : 'production' as const, locale: input.locale === 'en' ? 'en' : input.locale === 'de' ? 'de' : null, updatedAt: new Date() }
  await db.delete(schema.appDevices).where(and(eq(schema.appDevices.pushToken, token)))
  await db.delete(schema.appDevices).where(eq(schema.appDevices.sessionId, s.session!.id))
  await db.insert(schema.appDevices).values(values)
}

export async function unregisterPush(db: DbOrTx, s: SessionInfo): Promise<boolean> {
  const rows = await db.delete(schema.appDevices).where(eq(schema.appDevices.sessionId, s.session!.id)).returning({ id: schema.appDevices.id })
  return rows.length > 0
}

export { ALL_SLUG }
