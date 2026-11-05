import type { H3Event } from 'h3'
import { createError, getHeader, setCookie, setResponseHeader } from 'h3'
import type { SessionMethod } from '../db/schema'
import { createSession, hasStepUp, SESSION_COOKIE, type SessionInfo } from '../lib/auth'
import { AuthError } from '../lib/auth-codes'
import { config } from '../lib/config'
import type { Db } from '../lib/db'
import { emitUserLoggedIn } from '../lib/extensions'

export async function authGuard<T>(event: H3Event, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  }
  catch (err) {
    if (err instanceof AuthError) {
      if (err.retryAfter) setResponseHeader(event, 'Retry-After', err.retryAfter)
      throw createError({ statusCode: err.status, statusMessage: err.message, data: err.data })
    }
    throw err
  }
}

export function setSessionCookie(event: H3Event, token: string): void {
  setCookie(event, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: config.sessionDays * 86_400 })
}

export async function startSession(event: H3Event, db: Db, userId: string, workspaceId: string, method: SessionMethod, stepUpAt?: Date | null): Promise<void> {
  const token = await createSession(db, userId, workspaceId, { method, userAgent: getHeader(event, 'user-agent') ?? '', stepUpAt })
  await emitUserLoggedIn(db, { userId, workspaceId })
  setSessionCookie(event, token)
}

export function requireStepUp(s: SessionInfo): void {
  if (!hasStepUp(s)) throw createError({ statusCode: 403, statusMessage: 'Bitte zuerst bestätigen', data: { stepUp: true } })
}
