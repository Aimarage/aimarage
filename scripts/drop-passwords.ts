import { isNotNull, sql } from 'drizzle-orm'
import { config } from '../server/lib/config'
import { closeDb, getDb, schema } from '../server/lib/db'

// Entfernt alle Passwörter (users.password_hash = null). Erst ausführen, wenn
// AUTH_PASSWORD=false gesetzt ist und alle Konten per Code oder Passkey hineinkommen.
// Aufruf: node --env-file-if-exists=.env --import tsx scripts/drop-passwords.ts [--yes] [--force]

const yes = process.argv.includes('--yes')
const force = process.argv.includes('--force')

if (config.authPassword) {
  console.error('AUTH_PASSWORD ist noch an. Erst AUTH_PASSWORD=false setzen und neu starten.')
  process.exit(1)
}

const db = await getDb()
const rows = await db.select({
  id: schema.users.id,
  email: schema.users.email,
  passkeys: sql<number>`(select count(*)::int from passkeys p where p.user_id = ${schema.users.id})`,
}).from(schema.users).where(isNotNull(schema.users.passwordHash))

const withoutPasskey = rows.filter(r => !r.passkeys)
const invalidMail = rows.filter(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email))
console.log(`${rows.length} Konten mit Passwort, davon ${withoutPasskey.length} ohne Passkey.`)
for (const r of invalidMail) console.log(`  Achtung: ${r.email} ist keine gültige Mailadresse, Anmeldung per Code geht dort nicht.`)

if (!yes) {
  console.log('Probelauf. Mit --yes werden die Passwörter wirklich entfernt.')
  await closeDb()
  process.exit(0)
}
if (invalidMail.length && !force) {
  console.error('Abbruch: Konten ohne gültige Mailadresse kämen nicht mehr hinein. Adresse ändern oder --force.')
  await closeDb()
  process.exit(1)
}

const res = await db.update(schema.users).set({ passwordHash: null }).where(isNotNull(schema.users.passwordHash)).returning({ id: schema.users.id })
console.log(`${res.length} Passwörter entfernt.`)
await closeDb()
