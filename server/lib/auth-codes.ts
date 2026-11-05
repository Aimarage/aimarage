import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AuthCodePurpose } from '../db/schema'
import { now } from './clock'
import { config } from './config'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { emitSignupVerified, reportError } from './extensions'
import { RateLimiter } from './ratelimit'
import { derivedKey } from './secret'
import { sendSystemMail, SystemMailError } from './system-mail'

export const CODE_TTL_MINUTES = 10
export const CODE_MAX_ATTEMPTS = 5
export const REGISTRATION_TOKEN_MINUTES = 30

export const limits = {
  requestEmail: new RateLimiter('code-email', 5, 15 * 60_000),
  requestIp: new RateLimiter('code-ip', 30, 60 * 60_000),
  verifyIp: new RateLimiter('verify-ip', 60, 60 * 60_000),
  failTarget: new RateLimiter('code-fail', 10, 60 * 60_000),
  userCode: new RateLimiter('code-user', 5, 15 * 60_000),
}

export class AuthError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfter?: number, public readonly data?: Record<string, unknown>) {
    super(message)
  }
}

const emailSchema = z.email().max(254)

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (!emailSchema.safeParse(email).success) throw new AuthError(400, 'Bitte eine gültige E-Mail-Adresse eingeben')
  return email
}

export function newNumericCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function hashCode(purpose: string, target: string, code: string): string {
  return createHmac('sha256', derivedKey('auth-code')).update(`${purpose}:${target}:${code}`).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function limit(db: DbOrTx, limiter: RateLimiter, key: string): Promise<void> {
  const wait = await limiter.retryAfter(db, key)
  if (wait) throw new AuthError(429, 'Zu viele Versuche, bitte kurz warten', wait)
  await limiter.fail(db, key)
}

export async function issueCode(db: DbOrTx, purpose: AuthCodePurpose, target: string, userId: string | null): Promise<string> {
  const code = newNumericCode()
  const at = now()
  await db.update(schema.authCodes).set({ consumedAt: at })
    .where(and(eq(schema.authCodes.purpose, purpose), eq(schema.authCodes.target, target), isNull(schema.authCodes.consumedAt)))
  await db.insert(schema.authCodes).values({
    purpose,
    target,
    userId,
    codeHash: hashCode(purpose, target, code),
    expiresAt: new Date(at.getTime() + CODE_TTL_MINUTES * 60_000),
    createdAt: at,
  })
  return code
}

export async function checkCode(db: DbOrTx, purpose: AuthCodePurpose, target: string, rawCode: string, userId: string | null): Promise<{ userId: string | null }> {
  const code = rawCode.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(code)) throw new AuthError(400, 'Der Code hat 6 Ziffern')
  const failKey = `${purpose}:${target}`
  const wait = await limits.failTarget.retryAfter(db, failKey)
  if (wait) throw new AuthError(429, 'Zu viele falsche Codes für diese Adresse, bitte später erneut', wait)
  const at = now()
  const conds = [eq(schema.authCodes.purpose, purpose), eq(schema.authCodes.target, target), isNull(schema.authCodes.consumedAt), gt(schema.authCodes.expiresAt, at)]
  if (userId) conds.push(eq(schema.authCodes.userId, userId))
  const [row] = await db.select().from(schema.authCodes).where(and(...conds)).orderBy(desc(schema.authCodes.createdAt)).limit(1)
  if (!row) throw new AuthError(400, 'Der Code ist abgelaufen, bitte einen neuen anfordern')
  const [upd] = await db.update(schema.authCodes).set({ attempts: sql`${schema.authCodes.attempts} + 1` })
    .where(and(eq(schema.authCodes.id, row.id), lt(schema.authCodes.attempts, CODE_MAX_ATTEMPTS)))
    .returning({ attempts: schema.authCodes.attempts })
  if (!upd) throw new AuthError(429, 'Zu viele falsche Versuche, bitte einen neuen Code anfordern')
  if (!safeEqualHex(row.codeHash, hashCode(purpose, target, code))) {
    await limits.failTarget.fail(db, failKey)
    if (upd.attempts >= CODE_MAX_ATTEMPTS) {
      await db.update(schema.authCodes).set({ consumedAt: now() }).where(eq(schema.authCodes.id, row.id))
      throw new AuthError(429, 'Zu viele falsche Versuche, bitte einen neuen Code anfordern')
    }
    throw new AuthError(400, 'Der Code stimmt nicht')
  }
  const [consumed] = await db.update(schema.authCodes).set({ consumedAt: now() })
    .where(and(eq(schema.authCodes.id, row.id), isNull(schema.authCodes.consumedAt))).returning({ id: schema.authCodes.id })
  if (!consumed) throw new AuthError(400, 'Der Code wurde schon verwendet')
  return { userId: row.userId }
}

export async function findUserByEmail(db: DbOrTx, email: string) {
  const [u] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`).limit(1)
  return u ?? null
}

async function deliver(send: () => Promise<unknown>): Promise<void> {
  try {
    await send()
  }
  catch (err) {
    if (err instanceof SystemMailError) {
      console.error(`[auth] Mail fehlgeschlagen: ${err.message}`)
      await reportError({ source: 'mail', message: err.message, detail: { kind: 'auth' } })
      throw new AuthError(502, 'Die Mail konnte nicht gesendet werden, bitte später erneut')
    }
    throw err
  }
}

export async function requestLoginCode(db: DbOrTx, input: { email: string, ip: string, locale?: string }): Promise<void> {
  const email = normalizeEmail(input.email)
  await limit(db, limits.requestIp, input.ip)
  await limit(db, limits.requestEmail, email)
  const user = await findUserByEmail(db, email)
  if (!user && !config.hosted) return
  const code = await issueCode(db, 'login', email, user?.id ?? null)
  await deliver(() => sendSystemMail(email, 'login-code', { code, minutes: CODE_TTL_MINUTES }, user?.locale ?? input.locale ?? 'de'))
}

export type VerifyResult =
  | { kind: 'user', user: typeof schema.users.$inferSelect }
  | { kind: 'register', email: string, token: string }

export async function verifyLoginCode(db: Db, input: { email: string, code: string, ip: string }): Promise<VerifyResult> {
  const email = normalizeEmail(input.email)
  await limit(db, limits.verifyIp, input.ip)
  await checkCode(db, 'login', email, input.code, null)
  const user = await findUserByEmail(db, email)
  if (user) {
    await db.update(schema.users).set({ lastLoginAt: now(), ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: now() }) }).where(eq(schema.users.id, user.id))
    return { kind: 'user', user }
  }
  if (!config.hosted) throw new AuthError(400, 'Der Code ist abgelaufen, bitte einen neuen anfordern')
  await emitSignupVerified(db, { email, userId: null })
  return { kind: 'register', email, token: issueRegistrationToken(email) }
}

function sign(payload: string): string {
  return createHmac('sha256', derivedKey('registration-token')).update(payload).digest('base64url')
}

export function issueRegistrationToken(email: string, at = now()): string {
  const payload = Buffer.from(JSON.stringify({ e: email, x: at.getTime() + REGISTRATION_TOKEN_MINUTES * 60_000 })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function readRegistrationToken(token: string, at = now()): string | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const want = Buffer.from(sign(payload))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { e?: unknown, x?: unknown }
    if (typeof data.e !== 'string' || typeof data.x !== 'number' || data.x < at.getTime()) return null
    return data.e
  }
  catch {
    return null
  }
}

export async function requestUserCode(db: DbOrTx, purpose: 'step_up' | 'email_change', user: { id: string, email: string, locale: string }, target: string, action?: string): Promise<void> {
  await limit(db, limits.userCode, `${purpose}:${user.id}`)
  const code = await issueCode(db, purpose, target, user.id)
  if (purpose === 'step_up') await deliver(() => sendSystemMail(user.email, 'step-up', { code, minutes: CODE_TTL_MINUTES, ...(action ? { action } : {}) }, user.locale))
  else await deliver(() => sendSystemMail(target, 'email-change', { code, email: target, minutes: CODE_TTL_MINUTES }, user.locale))
}

export async function pruneAuthCodes(db: DbOrTx): Promise<void> {
  await db.delete(schema.authCodes).where(lt(schema.authCodes.expiresAt, new Date(now().getTime() - 86_400_000)))
}
