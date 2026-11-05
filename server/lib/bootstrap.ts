import { config } from './config'
import type { Db } from './db'
import { schema } from './db'
import { seedOwner } from './seed-owner'

async function isEmpty(db: Db): Promise<boolean> {
  const rows = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).limit(1)
  return rows.length === 0
}

export async function seedIfEmpty(db: Db, log: (m: string) => void = console.log): Promise<boolean> {
  if (config.seedOnStart !== 'owner' || !(await isEmpty(db))) return false
  const res = await seedOwner(db)
  log(`Arbeitsbereich angelegt, Anmeldung mit "${res.email}"${res.generatedPassword ? ` und dem Passwort ${res.generatedPassword} (bitte unter Einstellungen > Profil ändern)` : ' und SEED_PASSWORD'}.`)
  return true
}

const g = globalThis as unknown as { __maReady?: Promise<void> }

export function appReady(): Promise<void> {
  g.__maReady ??= (async () => {
    const { getDb } = await import('./db')
    const db = await getDb()
    const { installBraveMeter } = await import('./brave-usage')
    installBraveMeter(db)
    await seedIfEmpty(db, m => console.log(`[db] ${m}`))
    const { connectLoop } = await import('./upgrade')
    const n = await connectLoop(db)
    if (n) console.log(`[db] ${n} Projekte an die Planungsschleife angeschlossen`)
  })().catch((err) => {
    g.__maReady = undefined
    throw err
  })
  return g.__maReady
}
