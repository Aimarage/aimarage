import { and, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm'
import type { DbOrTx } from './db'
import { schema } from './db'
import { now } from './clock'
import { zonedToUtc } from './publish'
import { openTaskViews, type ViewRow } from './task-view'

type Workspace = typeof schema.workspaces.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type Draft = typeof schema.drafts.$inferSelect

export interface ReleasedRow {
  draft: Draft
  task: Task
  view: ViewRow
  out: boolean
  at: Date | null
  running: boolean
  goesOut: boolean
}

export interface DraftLists {
  // "Du bist dran": offene Entwürfe zum Freigeben und freigegebene Selbst-Posts ab ihrem Tag.
  yours: ReleasedRow[]
  // Kommt bald: noch nicht dran.
  soon: ReleasedRow[]
  // Prüft Claude bzw. der KI-Prüfer.
  claude: ReleasedRow[]
  // "Geht raus": die KI veröffentlicht selbst (verbundenes Konto, Blog-API, Postfach, Antwort).
  outgoing: ReleasedRow[]
}

// Alle Entwurfs-Listen aus derselben Quelle (taskViews). Datum in "Geht raus" = geplanter Versand, sonst Termin der Aufgabe.
export async function draftLists(db: DbOrTx, ws: Workspace, cond: SQL | undefined): Promise<DraftLists> {
  const rows = (await openTaskViews(db, ws, cond)).filter(r => r.view.draftId)
  const out: DraftLists = { yours: [], soon: [], claude: [], outgoing: [] }
  if (!rows.length) return out
  const drafts = new Map((await db.select().from(schema.drafts).where(inArray(schema.drafts.id, rows.map(r => r.view.draftId!)))).map(d => [d.id, d]))
  for (const { task, view } of rows) {
    const draft = drafts.get(view.draftId!)
    if (!draft) continue
    const at = view.at ? new Date(view.at) : task.dueDate ? zonedToUtc(task.dueDate, task.dueTime, ws.timezone) : null
    const row: ReleasedRow = { draft, task, view, out: view.bucket === 'outgoing', at, running: view.running, goesOut: view.bucket === 'outgoing' }
    if (view.bucket === 'yours') out.yours.push(row)
    else if (view.bucket === 'soon') out.soon.push(row)
    else if (view.bucket === 'claude') out.claude.push(row)
    else if (view.bucket === 'outgoing') out.outgoing.push(row)
  }
  out.outgoing.sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity))
  const byDue = (a: ReleasedRow, b: ReleasedRow) => `${a.task.dueDate ?? '9'}${a.task.dueTime ?? ''}`.localeCompare(`${b.task.dueDate ?? '9'}${b.task.dueTime ?? ''}`)
  out.soon.sort(byDue)
  out.yours.sort(byDue)
  out.claude.sort(byDue)
  return out
}

// Kompatibel: nur freigegebene Entwürfe (outgoing, selbst posten heute, kommt bald).
export async function releasedDrafts(db: DbOrTx, ws: Workspace, cond: SQL | undefined): Promise<{ outgoing: ReleasedRow[], self: ReleasedRow[], soon: ReleasedRow[] }> {
  const l = await draftLists(db, ws, cond)
  const approved = (r: ReleasedRow) => r.draft.status === 'freigegeben'
  return { outgoing: l.outgoing.filter(approved), self: l.yours.filter(approved), soon: l.soon.filter(approved) }
}

export async function recentlyDone(db: DbOrTx, ws: Workspace, cond: SQL | undefined, days = 7): Promise<{ draft: Draft, task: Task }[]> {
  const since = new Date(now().getTime() - days * 86_400_000)
  const rows = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.workspaceId, ws.id), eq(schema.drafts.status, 'freigegeben'), gte(schema.tasks.doneAt, since), sql`${schema.tasks.status} in ('wartet', 'erledigt', 'ausgewertet')`, cond))
    .orderBy(desc(schema.tasks.doneAt), desc(schema.drafts.version))
    .limit(60)
  const seen = new Set<string>()
  return rows.filter(r => (seen.has(r.task.id) ? false : (seen.add(r.task.id), true))).slice(0, 30)
}
