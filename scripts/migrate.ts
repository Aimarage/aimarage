import { and, eq, isNull } from 'drizzle-orm'
import { closeDb, getDb, schema } from '../server/lib/db'
import { today } from '../server/lib/clock'
import { planByBudget } from '../server/lib/time-budget'
import { syncAllSchedules } from '../server/lib/schedule-sync'
import { prepareSweeps } from '../server/lib/community-sweep'
import { dropProjectlessPlanTasks } from '../server/lib/materialize'
import { enqueueJob } from '../server/lib/jobs'
import { cleanConnErrors, dropLocalRedirects, hasTransientConn, updateSettings } from '../server/lib/connections'
import { config } from '../server/lib/config'

const db = await getDb()
console.log('Migrationen angewendet.')

// Weiterleitungs-Adressen auf localhost (aus der Datenübernahme lokal -> live) entfernen, dann gilt die Standard-Adresse der App.
for (const ws of await db.select({ id: schema.workspaces.id, name: schema.workspaces.name, settings: schema.workspaces.settings }).from(schema.workspaces)) {
  if (!ws.settings || !dropLocalRedirects(ws.settings, config.appUrl)) continue
  await updateSettings(db, ws.id, s => dropLocalRedirects(s, config.appUrl) ?? s)
  console.log(`Plattform-Zugänge ${ws.name}: localhost-Weiterleitung entfernt, gilt jetzt ${config.appUrl}`)
}

// Gespeicherte Verbindungsfehler mit HTML-Seite oder 5xx in Klartext umschreiben und gestörte Verbindungen gleich neu prüfen.
for (const ws of await db.select().from(schema.workspaces).where(isNull(schema.workspaces.deletedAt))) {
  if (ws.settings && cleanConnErrors(ws.settings)) {
    await updateSettings(db, ws.id, s => cleanConnErrors(s) ?? s)
    console.log(`Verbindungen ${ws.name}: Fehlertexte ohne HTML gespeichert`)
  }
  const [fresh] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
  if (fresh && hasTransientConn(fresh) && await enqueueJob(db, 'conn_recheck', { workspaceId: ws.id, dedupeKey: `conn_recheck:${ws.id}:migrate-${new Date().toISOString().slice(0, 13)}`, maxAttempts: 1 })) console.log(`Verbindungen ${ws.name}: gestörte Verbindungen werden neu geprüft`)
}

// Menschenarbeit nach dem Zeitbudget neu verteilen (idempotent, verschiebt nur bzw. markiert "fällt weg").
if (process.env.MIGRATE_PLAN !== '0') {
  const wss = await db.select().from(schema.workspaces).where(and(isNull(schema.workspaces.pausedAt), isNull(schema.workspaces.deletedAt)))
  for (const ws of wss) {
    try {
      const r = await planByBudget(db, ws, today(ws.timezone))
      if (r.moved || r.dropped || r.claude) console.log(`Zeitbudget ${ws.name}: ${r.moved} verschoben, ${r.dropped} fallen weg, ${r.claude} für Claude`)
      const s = await syncAllSchedules(db, ws, today(ws.timezone))
      if (s) console.log(`Termine ${ws.name}: ${s} Versandzeiten an den Termin der Aufgabe angepasst`)
      const gone = await dropProjectlessPlanTasks(db, ws.id)
      if (gone.length) console.log(`Startplan ${ws.name}: ${gone.join(', ')} verworfen (projektlose Sammeltermine)`)
      const sweeps = await prepareSweeps(db, ws, today(ws.timezone))
      if (sweeps.length) console.log(`Community ${ws.name}: ${sweeps.join(', ')} sucht jetzt der Agent selbst`)
      if (!ws.demo && await enqueueJob(db, 'seo_audit', { workspaceId: ws.id, dedupeKey: `seo_audit:${ws.id}:alle-funde`, maxAttempts: 1 })) console.log(`SEO ${ws.name}: neue Prüfung, jede Fund-Art bekommt eine Aufgabe für Claude`)
    }
    catch (err) {
      console.error(`Zeitbudget ${ws.name} nicht verteilt: ${(err as Error).message}`)
    }
  }
}
await closeDb()
