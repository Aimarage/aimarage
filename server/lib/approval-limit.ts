import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { addDays, weekday } from '../../shared/utils/dates'
import { taskType, type TaskShape } from '../../shared/utils/drafting'
import { DRAFT_AHEAD_DEFAULT } from '../../shared/utils/plan'
import type { DbOrTx } from './db'
import { schema } from './db'
import { pendingJobs } from './jobs'
import { placePost } from './post-slots'
import { updateTask, type TaskRow } from './tasks'

type Workspace = Pick<typeof schema.workspaces.$inferSelect, 'id' | 'settings' | 'timezone'>

export const APPROVALS_PER_DAY = 5
// Kurzer Vorlauf (heute für heute und morgen) für Antworten, Community und Recherche, sonst der Vorlauf des Projekts.
export const NEAR_DAYS = 1

export function approvalsPerDay(ws: Pick<Workspace, 'settings'>): number {
  const n = ws.settings?.approvalsPerDay
  return typeof n === 'number' && n >= 1 ? Math.floor(n) : APPROVALS_PER_DAY
}

const PRIO_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 }
const REDDIT = /(reddit|(^|[\s/(])r\/)/i

// Teil n/m einer Serie (z.B. "Album-Serie 6/12: Track"): Schlüssel und Nummer, sonst null.
export function seriesPart(t: Pick<TaskRow, 'title' | 'projectId' | 'campaignId'>): { key: string, idx: number } | null {
  const m = /^(.*?)(\d{1,3})\/(\d{1,3})(?!\d)/.exec(t.title)
  if (!m) return null
  const idx = Number(m[2])
  const total = Number(m[3])
  if (total < 2 || idx < 1 || idx > total) return null
  const prefix = m[1]!.trim().toLowerCase().replace(/[(\[\s]+$/, '')
  return { key: `${t.projectId ?? ''}|${t.campaignId ?? prefix}|${total}`, idx }
}

// Agenten-Entwürfe (brauchen Freigabe) auf höchstens n fällige je Tag verteilen.
// Fest sind: vom Menschen angelegt, mit Uhrzeit, Meilenstein, Reddit (erlaubte Tage), Experiment
// und schon geschriebene Entwürfe, solange nicht überfällig. Überfällige rücken auf heute bzw. den nächsten freien Tag.
// Serien behalten ihre Reihenfolge: rückt ein Teil nach, rücken die späteren mit statt ihn zu überholen.
// Jede Verschiebung läuft über placePost (Abstand zu anderen Posts auf gleicher Plattform, Tageshöchstzahl).
export async function spreadDraftTasks(db: DbOrTx, ws: Workspace, today: string): Promise<number> {
  const limit = approvalsPerDay(ws)
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig']),
    isNotNull(schema.tasks.agentStep),
    isNotNull(schema.tasks.draftKind),
    isNotNull(schema.tasks.dueDate),
  ))
  if (!rows.length) return 0
  const drafted = new Set((await db.select({ id: schema.drafts.taskId }).from(schema.drafts).where(and(inArray(schema.drafts.taskId, rows.map(r => r.id)), eq(schema.drafts.status, 'offen')))).map(r => r.id))
  const pinned = (t: TaskRow) => !!t.createdByUserId || !!t.dueTime || t.milestone || !!t.experimentId || REDDIT.test(`${t.channel ?? ''} ${t.title}`)
  const fixed = (t: TaskRow) => t.dueDate! >= today && (pinned(t) || drafted.has(t.id) || t.status !== 'geplant')
  const count = new Map<string, number>()
  const add = (d: string, n: number) => count.set(d, (count.get(d) ?? 0) + n)
  for (const t of rows.filter(fixed)) add(t.dueDate!, 1)
  const from = (t: TaskRow) => (t.dueDate! < today ? today : t.dueDate!)
  const free = rows.filter(t => !fixed(t)).sort((a, b) => from(a).localeCompare(from(b)) || Number(drafted.has(b.id)) - Number(drafted.has(a.id)) || PRIO_RANK[a.prio]! - PRIO_RANK[b.prio]! || a.dueDate!.localeCompare(b.dueDate!) || a.code.localeCompare(b.code))
  const day = new Map<string, string>()
  for (const t of free) {
    let d = from(t)
    while ((count.get(d) ?? 0) >= limit) d = addDays(d, 1)
    add(d, 1)
    day.set(t.id, d)
  }
  const planned = (t: TaskRow) => day.get(t.id) ?? t.dueDate!
  const move = async (t: TaskRow, d: string): Promise<TaskRow> => {
    const row = await updateTask(db, t, { dueDate: d }, { type: 'system' }, { spread: false })
    return row.category === 'social' ? placePost(db, row, { pinned: false }) : row
  }
  let moved = 0
  const series = new Map<string, { t: TaskRow, idx: number }[]>()
  for (const t of rows) {
    const s = seriesPart(t)
    if (s) series.set(s.key, [...(series.get(s.key) ?? []), { t, idx: s.idx }])
  }
  const inSeries = new Set<string>()
  for (const parts of series.values()) {
    if (parts.length < 2) continue
    parts.sort((a, b) => a.idx - b.idx)
    let prev: { date: string, orig: string } | null = null
    for (const { t } of parts) {
      inSeries.add(t.id)
      let d = planned(t)
      const min = prev ? addDays(prev.date, t.dueDate! > prev.orig ? 1 : 0) : d
      if (d < min) {
        add(d, -1)
        d = min
        while ((count.get(d) ?? 0) >= limit) d = addDays(d, 1)
        add(d, 1)
      }
      const row = d === t.dueDate ? t : await move(t, d)
      if (row !== t) moved++
      prev = { date: row.dueDate!, orig: t.dueDate! }
    }
  }
  for (const t of free) {
    if (inSeries.has(t.id) || planned(t) === t.dueDate) continue
    await move(t, planned(t))
    moved++
  }
  return moved
}

export interface DraftBudget {
  // Neue Entwürfe heute insgesamt (bald fällige zuerst).
  total: number
  // Davon höchstens so viele mit Termin nach morgen (Vorlauf), damit der Aufbau des Vorlaufs die KI-Kosten nicht sprengt.
  ahead: number
}

// Gestaffelt: bald fällige wie bisher bis zum Freigaben-Tageslimit, für den Vorlauf zusätzlich bis zum doppelten Limit je Tag.
// Heute geschriebene Entwürfe und wartende Jobs zählen.
export async function draftBudget(db: DbOrTx, ws: Workspace, today: string): Promise<DraftBudget> {
  const limit = approvalsPerDay(ws)
  const soon = addDays(today, NEAR_DAYS)
  const [{ n, far } = { n: 0, far: 0 }] = await db.select({
    n: sql<number>`count(distinct ${schema.drafts.taskId})::int`,
    far: sql<number>`count(distinct ${schema.drafts.taskId}) filter (where ${schema.tasks.dueDate} > ${soon})::int`,
  }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId)).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    eq(schema.drafts.byAgent, true),
    eq(schema.drafts.version, 1),
    sql`(${schema.drafts.createdAt} at time zone ${ws.timezone})::date = ${today}`,
  ))
  const queued = (await pendingJobs(db, ws.id)).filter(j => j.type === 'draft_task' && j.taskId).map(j => j.taskId!)
  const queuedFar = queued.length ? (await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(inArray(schema.tasks.id, queued), sql`${schema.tasks.dueDate} > ${soon}`))).length : 0
  const total = Math.max(0, limit * 3 - n - queued.length)
  return { total, ahead: Math.min(total, Math.max(0, limit * 2 - far - queuedFar)) }
}

// Langer Vorlauf für geplante Inhalte (Posts, Artikel, Verzeichnisse, Mails), kurzer für Antworten, Community und Recherche.
export function longLead(t: TaskShape): boolean {
  if (t.category === 'community' || REDDIT.test(`${t.channel ?? ''} ${t.title}`)) return false
  return ['post', 'article', 'directory', 'mail', 'pitch'].includes(taskType(t))
}

// Freigaben, die heute oder morgen fällig sind (ohne Termin zählt als fällig).
export const dueSoon = (today: string) => sql`(${schema.tasks.dueDate} is null or ${schema.tasks.dueDate} <= ${addDays(today, 1)})`

export const draftHorizon = (today: string, days = DRAFT_AHEAD_DEFAULT) => addDays(today, days)

// Bis zu welchem Tag alles freigegeben ist, was eine Freigabe braucht: der Tag vor der ersten noch offenen Freigabe ab heute.
// null, wenn schon heute etwas offen ist oder nichts im Voraus freigegeben wurde.
export async function approvedUntil(db: DbOrTx, ws: typeof schema.workspaces.$inferSelect, today: string, projectIds: string[] | null = null): Promise<string | null> {
  if (projectIds && !projectIds.length) return null
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    projectIds ? inArray(schema.tasks.projectId, projectIds) : undefined,
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']),
    isNotNull(schema.tasks.agentStep),
    isNotNull(schema.tasks.draftKind),
    sql`${schema.tasks.dueDate} >= ${today}`,
  ))
  if (!rows.length) return null
  const { routeContext } = await import('./route')
  const routeOf = await routeContext(db, ws)
  let first: string | null = null
  for (const t of rows) {
    if (t.status === 'freigegeben' || routeOf(t).route === 'auto') continue
    if (!first || t.dueDate! < first) first = t.dueDate!
  }
  const approved = rows.filter(t => t.status === 'freigegeben' && (!first || t.dueDate! < first)).map(t => t.dueDate!).sort()
  if (!approved.length || first === today) return null
  return first ? addDays(first, -1) : approved.at(-1)!
}

const DAY_NAMES = { de: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }

export function shortDay(d: string, locale: 'de' | 'en'): string {
  const [, m, day] = d.split('-')
  return locale === 'en' ? `${DAY_NAMES.en[weekday(d) - 1]} ${Number(m)}/${Number(day)}` : `${DAY_NAMES.de[weekday(d) - 1]} ${day}.${m}.`
}
