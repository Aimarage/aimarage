import { and, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm'
import { addDays, diffDays } from '../../shared/utils/dates'
import { taskType } from '../../shared/utils/drafting'
import { linkLabel } from '../../shared/utils/links'
import type { DbOrTx } from './db'
import { schema } from './db'

export interface HistoryLink {
  platform: string | null
  label: string
  url: string
}

export interface HistoryEntry {
  taskId: string
  code: string
  title: string
  projectId: string | null
  category: string
  at: string
  day: string
  links: HistoryLink[]
}

export interface History {
  from: string
  to: string
  total: number
  perDay: { day: string, n: number }[]
  entries: HistoryEntry[]
}

export async function loadHistory(db: DbOrTx, input: { workspaceId: string, scope?: SQL, from: string, to: string, timezone: string }): Promise<History> {
  const { from, to, timezone: tz } = input
  const scope = and(eq(schema.tasks.workspaceId, input.workspaceId), input.scope)
  const linkDay = sql<string>`to_char(${schema.taskLinks.postedAt} at time zone ${tz}, 'YYYY-MM-DD')`
  const links = await db.select({ taskId: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, projectId: schema.tasks.projectId, category: schema.tasks.category, platform: schema.taskLinks.platform, url: schema.taskLinks.url, at: schema.taskLinks.postedAt, day: linkDay })
    .from(schema.taskLinks).innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskLinks.taskId))
    .where(and(scope, sql`(${schema.taskLinks.postedAt} at time zone ${tz})::date between ${from} and ${to}`))
    .orderBy(schema.taskLinks.postedAt, schema.taskLinks.createdAt)
    .limit(5000)
  const done = await db.select({ taskId: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, projectId: schema.tasks.projectId, category: schema.tasks.category, draftKind: schema.tasks.draftKind, postedUrl: schema.tasks.postedUrl, at: schema.tasks.doneAt, day: sql<string>`to_char(${schema.tasks.doneAt} at time zone ${tz}, 'YYYY-MM-DD')` })
    .from(schema.tasks)
    .where(and(scope, isNotNull(schema.tasks.doneAt), inArray(schema.tasks.status, ['erledigt', 'ausgewertet', 'wartet']),
      sql`(${schema.tasks.doneAt} at time zone ${tz})::date between ${from} and ${to}`,
      ne(schema.tasks.category, 'bericht'), sql`coalesce(${schema.tasks.origin}, '') not like 'setup:%'`,
      sql`not exists (select 1 from ${schema.taskLinks} where ${schema.taskLinks.taskId} = ${schema.tasks.id})`))
    .limit(5000)

  const byKey = new Map<string, HistoryEntry>()
  for (const l of links) {
    const key = `${l.taskId}|${l.day}`
    let e = byKey.get(key)
    if (!e) {
      e = { taskId: l.taskId, code: l.code, title: l.title, projectId: l.projectId, category: l.category, at: l.at.toISOString(), day: l.day, links: [] }
      byKey.set(key, e)
    }
    if (!e.links.some(x => x.url === l.url)) e.links.push({ platform: l.platform, label: linkLabel(l.platform, l.url), url: l.url })
  }
  const entries = [...byKey.values(), ...done.filter(d => d.postedUrl || taskType(d) !== 'research').map(d => ({ taskId: d.taskId, code: d.code, title: d.title, projectId: d.projectId, category: d.category, at: d.at!.toISOString(), day: d.day, links: d.postedUrl ? [{ platform: null, label: linkLabel(null, d.postedUrl), url: d.postedUrl }] : [] }))]
    .sort((a, b) => b.at.localeCompare(a.at))
  const counts = new Map<string, number>()
  for (const e of entries) counts.set(e.day, (counts.get(e.day) ?? 0) + 1)
  const perDay = Array.from({ length: diffDays(to, from) + 1 }, (_, i) => addDays(from, i)).map(day => ({ day, n: counts.get(day) ?? 0 }))
  return { from, to, total: entries.length, perDay, entries }
}
