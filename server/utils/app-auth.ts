import type { H3Event } from 'h3'
import { roleAtLeast, type Role } from '../../shared/utils/domain'
import { resolveSession, type SessionInfo } from '../lib/auth'
import { badTokenLimiter, clientIp } from '../lib/api/http'
import { bearerOf } from '../lib/api/principal'
import { appSafeError, appText, type SafeLang } from '../lib/app/safe'
import { getDb } from '../lib/db'
import { accessGate, gateAllows } from '../lib/extensions'
import { RateLimiter } from '../lib/ratelimit'

declare module 'h3' {
  interface H3EventContext {
    appSession?: SessionInfo | null
  }
}

export const APP_PER_MINUTE = 300
export const appLimiter = new RateLimiter('app', APP_PER_MINUTE, 60_000)

export const appLang = (s: { user: { locale?: string | null } } | null | undefined): SafeLang => (s?.user.locale === 'en' ? 'en' : 'de')

// iPhone-App: Geräte-Token im Header Authorization: Bearer ama_...; Web-Cookies gelten hier nicht.
export async function requireApp(event: H3Event, min: Role = 'viewer'): Promise<SessionInfo> {
  if (event.context.appSession) {
    if (!roleAtLeast(event.context.appSession.role, min)) throw createError({ statusCode: 403, statusMessage: appText('Keine Berechtigung', appLang(event.context.appSession)) })
    return event.context.appSession
  }
  const db = await getDb()
  const ip = clientIp(event)
  const wait = await badTokenLimiter.retryAfter(db, ip)
  if (wait) {
    setResponseHeader(event, 'Retry-After', wait)
    throw createError({ statusCode: 429, statusMessage: 'Zu viele ungültige Anmeldungen, später nochmal' })
  }
  const token = bearerOf(getHeader(event, 'authorization'))
  const s = token ? await resolveSession(db, token, 'app') : null
  if (!s) {
    if (token) await badTokenLimiter.fail(db, ip)
    throw createError({ statusCode: 401, statusMessage: 'Nicht angemeldet' })
  }
  const limit = await appLimiter.hit(db, s.session!.id)
  if (limit) {
    setResponseHeader(event, 'Retry-After', limit)
    throw createError({ statusCode: 429, statusMessage: appText('Zu viele Anfragen', appLang(s)) })
  }
  event.context.appSession = s
  if (!roleAtLeast(s.role, min)) throw createError({ statusCode: 403, statusMessage: appText('Keine Berechtigung', appLang(s)) })
  const gate = await accessGate(db, s)
  if (gate && !gateAllows(gate, event.path)) throw createError({ statusCode: 409, statusMessage: gate.appMessage[appLang(s)], data: { gate: gate.code } })
  return s
}

// Fehler der App-Logik (AppError) als HTTP-Antwort in der Sprache des Nutzers. Limit-Fehler und Texte mit Kaufhinweis werden neutral (App-Store-Regeln).
export async function appGuard<T>(fn: () => Promise<T>, s?: { user: { locale?: string | null } } | null): Promise<T> {
  const l = appLang(s)
  try {
    return await fn()
  }
  catch (err) {
    const e = err as { status?: number, message?: string, appError?: boolean, data?: unknown }
    if (e?.appError) throw appSafeError(createError({ statusCode: e.status ?? 400, statusMessage: e.message, data: e.data }), l)
    throw appSafeError(err, l)
  }
}
