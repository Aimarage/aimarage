import { and, eq, inArray } from 'drizzle-orm'
import type { NotificationChannel } from '../db/schema'
import type { DbOrTx } from './db'
import { schema } from './db'
import { queueSystemMail } from './system-mail'

export interface NotifyText {
  subject: string
  body: string
  actionUrl?: string
  actionLabel?: string
}

export interface NotifyPayload extends Record<string, unknown> {
  text?: Partial<Record<'de' | 'en', NotifyText>>
}

export interface NotifyOptions {
  dedupeKey?: string
  channels?: NotificationChannel[]
  runAt?: Date
}

function textFor(payload: NotifyPayload, locale: string): NotifyText | null {
  const t = payload.text
  if (!t) return null
  return (locale === 'en' ? t.en ?? t.de : t.de ?? t.en) ?? null
}

// Legt je Empfänger eine Benachrichtigung an und verschickt sie über die Kanäle. Vorerst nur Mail, später Push.
// user = null: alle Inhaber und Admins des Workspace.
export async function notify(db: DbOrTx, ws: { id: string } | string, user: string | null, kind: string, payload: NotifyPayload = {}, opts: NotifyOptions = {}): Promise<number> {
  const workspaceId = typeof ws === 'string' ? ws : ws.id
  const channels = opts.channels ?? ['mail']
  const recipients = user
    ? await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, locale: schema.users.locale }).from(schema.users).innerJoin(schema.memberships, and(eq(schema.memberships.userId, schema.users.id), eq(schema.memberships.workspaceId, workspaceId))).where(eq(schema.users.id, user))
    : await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, locale: schema.users.locale }).from(schema.users).innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id)).where(and(eq(schema.memberships.workspaceId, workspaceId), inArray(schema.memberships.role, ['owner', 'admin'])))
  let sent = 0
  for (const r of recipients) {
    const dedupeKey = opts.dedupeKey ? `${opts.dedupeKey}:${r.id}` : null
    const rows = await db.insert(schema.notifications).values({ workspaceId, userId: r.id, kind, payload, channels, dedupeKey }).onConflictDoNothing().returning({ id: schema.notifications.id })
    const row = rows[0]
    if (!row) continue
    sent++
    const text = textFor(payload, r.locale)
    if (channels.includes('mail') && text && r.email.includes('@')) {
      await queueSystemMail(db, r.email, 'generic-notice', { subject: text.subject, body: text.body, name: r.name, actionUrl: text.actionUrl, actionLabel: text.actionLabel }, r.locale, { dedupeKey: `notify:${row.id}`, ...(opts.runAt ? { runAt: opts.runAt } : {}) })
    }
  }
  return sent
}
