import type { H3Event } from 'h3'
import type { ZodType } from 'zod'
import { roleAtLeast, type Role } from '../../shared/utils/domain'
import { resolveSession, SESSION_COOKIE, type SessionInfo } from '../lib/auth'
import { getDb } from '../lib/db'
import { accessGate, gateAllows } from '../lib/extensions'

declare module 'h3' {
  interface H3EventContext {
    session?: SessionInfo | null
  }
}

export async function loadSession(event: H3Event): Promise<SessionInfo | null> {
  if (event.context.session !== undefined) return event.context.session
  const db = await getDb()
  event.context.session = await resolveSession(db, getCookie(event, SESSION_COOKIE))
  return event.context.session
}

export async function requireAuth(event: H3Event, min: Role = 'viewer'): Promise<SessionInfo> {
  const s = await loadSession(event)
  if (!s) throw createError({ statusCode: 401, statusMessage: 'Nicht angemeldet' })
  if (!roleAtLeast(s.role, min)) throw createError({ statusCode: 403, statusMessage: 'Keine Berechtigung' })
  const gate = await accessGate(await getDb(), s)
  if (gate && !gateAllows(gate, event.path)) throw createError({ statusCode: 409, statusMessage: gate.message[s.user.locale === 'en' ? 'en' : 'de'], data: { gate: gate.code, path: gate.path } })
  return s
}

export async function parseBody<T>(event: H3Event, schema: ZodType<T>): Promise<T> {
  const raw = await readBody(event).catch(() => ({}))
  const res = schema.safeParse(raw ?? {})
  if (!res.success) throw createError({ statusCode: 400, statusMessage: 'Ungültige Eingabe', data: res.error.issues })
  return res.data
}

export function parseQuery<T>(event: H3Event, schema: ZodType<T>): T {
  const res = schema.safeParse(getQuery(event))
  if (!res.success) throw createError({ statusCode: 400, statusMessage: 'Ungültige Abfrage', data: res.error.issues })
  return res.data
}
