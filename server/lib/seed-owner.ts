import { randomBytes } from 'node:crypto'
import { hashPassword } from './auth'
import type { Db } from './db'
import { schema } from './db'

export interface OwnerSeed {
  workspaceId: string
  userId: string
  email: string
  generatedPassword: string | null
}

// Erstanlage für Selbst-Installation: ein leerer Arbeitsbereich mit Inhaber aus SEED_EMAIL/SEED_PASSWORD.
// Ohne SEED_PASSWORD wird ein zufälliges Passwort erzeugt und einmal ins Protokoll geschrieben.
export async function seedOwner(db: Db): Promise<OwnerSeed> {
  const email = (process.env.SEED_EMAIL || 'admin').trim()
  const name = (process.env.SEED_NAME || email.split('@')[0] || 'Admin').trim()
  const given = process.env.SEED_PASSWORD || ''
  const password = given || randomBytes(12).toString('base64url')
  const locale = process.env.SEED_LOCALE === 'en' ? 'en' : 'de'
  const timezone = process.env.SEED_TIMEZONE || 'Europe/Vienna'
  return db.transaction(async (tx) => {
    const [ws] = await tx.insert(schema.workspaces).values({
      name: process.env.SEED_WORKSPACE || (locale === 'en' ? 'My workspace' : 'Mein Arbeitsbereich'),
      locale,
      timezone,
      settings: { agentEnabled: true, publishLive: false, sendLive: false, briefingTime: '06:30' },
    }).returning({ id: schema.workspaces.id })
    const [user] = await tx.insert(schema.users).values({ email, name, locale, passwordHash: await hashPassword(password), prefs: { calView: 'week' } }).returning({ id: schema.users.id })
    await tx.insert(schema.memberships).values({ workspaceId: ws!.id, userId: user!.id, role: 'owner' })
    return { workspaceId: ws!.id, userId: user!.id, email, generatedPassword: given ? null : password }
  })
}
