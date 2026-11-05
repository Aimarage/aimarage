import { eq, ilike } from 'drizzle-orm'
import { closeDb, getDb, schema } from '../server/lib/db'
import { updateSettings } from '../server/lib/connections'
import type { LlmSettings } from '../server/db/schema'

// Setzt die eigene KI-Anbieter-Wahl eines Workspace zurück (Anbieter, Adresse, Modell), danach gilt die LLM_*-Vorgabe der .env.
// Gespeicherte Schlüssel und das starke Modell bleiben unberührt. Mehrfach ausführbar.
// Aufruf: node --import tsx scripts/llm-reset.ts <Workspace-ID|Name|Mail eines Mitglieds> [--yes]

const FIELDS = ['provider', 'baseUrl', 'model', 'modelFast', 'reasoning'] as const

const arg = process.argv.slice(2).find(a => !a.startsWith('--'))
const yes = process.argv.includes('--yes')
if (!arg) {
  console.error('Aufruf: scripts/llm-reset.ts <Workspace-ID|Name|Mail> [--yes]')
  process.exit(1)
}

const db = await getDb()
const isUuid = /^[0-9a-f-]{36}$/i.test(arg)
const byWs = await db.select({ id: schema.workspaces.id, name: schema.workspaces.name, settings: schema.workspaces.settings }).from(schema.workspaces)
  .where(isUuid ? eq(schema.workspaces.id, arg) : ilike(schema.workspaces.name, arg))
const byMail = isUuid || arg.indexOf('@') < 0
  ? []
  : await db.select({ id: schema.workspaces.id, name: schema.workspaces.name, settings: schema.workspaces.settings }).from(schema.workspaces)
      .innerJoin(schema.memberships, eq(schema.memberships.workspaceId, schema.workspaces.id))
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(ilike(schema.users.email, arg))
const list = [...new Map([...byWs, ...byMail].map(w => [w.id, w])).values()]
if (!list.length) {
  console.error('Kein Workspace gefunden.')
  await closeDb()
  process.exit(1)
}

const pick = (l: LlmSettings | undefined) => Object.fromEntries(FIELDS.filter(f => l?.[f] !== undefined).map(f => [f, l![f]]))
for (const w of list) {
  const before = pick(w.settings?.llm)
  const strong = w.settings?.llm?.strong
  console.log(`${w.name} (${w.id}): ${Object.keys(before).length ? JSON.stringify(before) : 'schon Standard'}${strong?.enabled ? `, starkes Modell an: ${strong.provider ?? 'Standard'} ${strong.model ?? ''}`.trimEnd() : ''}${w.settings?.llmEu ? ', EU-Modus an' : ''}`)
  if (!yes || !Object.keys(before).length) continue
  await updateSettings(db, w.id, (s) => {
    if (!s.llm) return s
    const next: LlmSettings = { ...s.llm }
    for (const f of FIELDS) delete next[f]
    s.llm = next
    return s
  })
  console.log('  zurückgesetzt')
}
if (!yes) console.log('Probelauf. Mit --yes wird zurückgesetzt.')
await closeDb()
