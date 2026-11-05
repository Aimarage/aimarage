import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { config } from './config'
import type { DbOrTx } from './db'
import { schema } from './db'
import { derivedKey } from './secret'

// Abmeldelink der Tagesmail: signiertes Token mit der Nutzer-ID, ohne Ablauf, ohne Login.
// Gleiche URL für den Link in der Mail (GET zeigt einen Knopf) und für One-Click (POST, RFC 8058).

function sign(userId: string): string {
  return createHmac('sha256', derivedKey('morning-unsubscribe-v1')).update(userId).digest('base64url').slice(0, 32)
}

export function unsubscribeToken(userId: string): string {
  return `${Buffer.from(userId).toString('base64url')}.${sign(userId)}`
}

export function readUnsubscribeToken(token: string): string | null {
  const [id, sig] = token.split('.')
  if (!id || !sig) return null
  const userId = Buffer.from(id, 'base64url').toString('utf8')
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null
  const want = Buffer.from(sign(userId))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  return userId
}

export function unsubscribeUrl(userId: string): string {
  return `${config.appUrl}/mail/abmelden?t=${unsubscribeToken(userId)}`
}

// Header für die Tagesmail: Abmelden im Mailprogramm und One-Click.
export function unsubscribeHeaders(userId: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${unsubscribeUrl(userId)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
}

export function morningMailOn(prefs: { morningMailOff?: boolean } | null | undefined): boolean {
  return !prefs?.morningMailOff
}

export async function setMorningMail(db: DbOrTx, userId: string, on: boolean): Promise<boolean> {
  const rows = await db.update(schema.users).set({ prefs: sql`${schema.users.prefs} || ${JSON.stringify({ morningMailOff: !on })}::jsonb` }).where(eq(schema.users.id, userId)).returning({ id: schema.users.id })
  return rows.length > 0
}
