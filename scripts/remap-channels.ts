import { isNull } from 'drizzle-orm'
import { closeDb, getDb, schema } from '../server/lib/db'
import { oldChannelNames, remapTasks, settleChannelHints } from '../server/lib/channel-match'
import { activeStrategy } from '../server/lib/strategy'

// Offene Aufgaben aus umbenannten oder neu geschnittenen Kanälen auf den passenden aktiven Kanal umhängen und falsche Hinweise "Kanal steht nicht mehr in der Strategie" erledigen. Idempotent.
const db = await getDb()
let n = 0
for (const p of await db.select({ id: schema.projects.id }).from(schema.projects).where(isNull(schema.projects.archivedAt))) {
  const st = await activeStrategy(db, p.id)
  if (!st) continue
  n += (await remapTasks(db, p.id, st.channels, await oldChannelNames(db, p.id))).length
  n += (await settleChannelHints(db, p.id, st.channels)).length
}
if (n) console.log(`Kanäle umgehängt bzw. Hinweise erledigt: ${n}`)
await closeDb()
