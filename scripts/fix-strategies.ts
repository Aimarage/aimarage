import { closeDb, getDb } from '../server/lib/db'
import { fixStrategies } from '../server/lib/strategy'

// Falsche Fakten in aktiven Strategien und Vorschlägen korrigieren (Domain aus der Projekt-Website, Zeit aus dem Zeitbudget). Idempotent.
const db = await getDb()
const n = await fixStrategies(db)
if (n) console.log(`Strategien korrigiert: ${n}`)
await closeDb()
