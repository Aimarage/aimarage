import { and, desc, eq, gte, inArray, lte, ne } from 'drizzle-orm'
import { addDays, minutesOf, timeOf, weekday } from '../../shared/utils/dates'
import { DONE_STATUSES } from '../../shared/utils/domain'
import { platformOf, taskListedPlatforms } from '../../shared/utils/drafting'
import { weekendPolicy } from '../../shared/utils/release'
import { nowTime, today } from './clock'
import { withChannelPlaces } from './channel-places'
import type { DbOrTx } from './db'
import { schema } from './db'
import { socialTarget } from './publish'
import { updateTask, type TaskRow } from './tasks'

// Zwei Social-Posts eines Projekts auf mindestens einer gleichen Plattform liegen mindestens POST_GAP_MIN auseinander.
export const POST_GAP_MIN = 180
export const DEFAULT_POST_TIME = '09:00'
const EARLIEST = '07:00'
const LATEST = '21:00'
const STEP = 15
const ALL = '*'

type SlotTask = Pick<TaskRow, 'category' | 'channel' | 'title' | 'targetUrl' | 'description'> & { channelPlaces?: string[] | null }

export function postPlatforms(t: SlotTask, postable: string[], draft?: string[] | null): string[] {
  if (draft?.length) return draft
  const listed = taskListedPlatforms(t)
  if (listed.length) return listed
  const own = platformOf(t)
  if (own && own !== 'forum') return [own]
  return postable.length ? postable : [ALL]
}

export function samePlatform(a: string[], b: string[]): boolean {
  return a.includes(ALL) || b.includes(ALL) || a.some(p => b.includes(p))
}

export interface SlotOpts {
  gap?: number
  today?: string
  now?: string
  weekend?: boolean
  maxPerDay?: number | null
  // Plattformen des zu setzenden Posts: die Tageshöchstzahl gilt je Plattform.
  platforms?: string[]
}

export interface Busy {
  date: string
  time: string
  platforms?: string[]
}

// Tageshöchstzahl je Plattform erreicht? Ohne Plattformen zählt jeder Post am Tag.
export function dayFull(date: string, busy: Busy[], max: number | null | undefined, platforms?: string[]): boolean {
  if (!max) return false
  const same = busy.filter(b => b.date === date)
  if (!platforms?.length) return same.length >= max
  return platforms.some(p => same.filter(b => !b.platforms || samePlatform([p], b.platforms)).length >= max)
}

function clashes(date: string, time: string, busy: Busy[], gap: number): boolean {
  const m = minutesOf(time)
  return busy.some(b => b.date === date && Math.abs(minutesOf(b.time) - m) < gap)
}

// Nächster freier Termin: erst später am selben Tag (Viertelstunden-Schritte bis 21:00), dann früher (ab 07:00), sonst die Folgetage zur gleichen Uhrzeit.
export function freeSlot(date: string, time: string, busy: Busy[], opts: SlotOpts = {}): { date: string, time: string } {
  const gap = opts.gap ?? POST_GAP_MIN
  const wanted = minutesOf(time)
  const lo = minutesOf(EARLIEST)
  const hi = minutesOf(LATEST)
  for (let off = 0; off < 14; off++) {
    const d = addDays(date, off)
    if (off > 0 && opts.weekend === false && weekday(d) >= 6) continue
    if (dayFull(d, busy, opts.maxPerDay, opts.platforms)) continue
    const later: number[] = []
    for (let m = wanted; m <= Math.max(hi, wanted); m += STEP) later.push(m)
    const earlier: number[] = []
    for (let m = wanted - STEP; m >= Math.min(lo, wanted); m -= STEP) earlier.push(m)
    for (const m of [...later, ...earlier]) {
      const t = timeOf(m)
      if (opts.today && opts.now && (d < opts.today || (d === opts.today && t <= opts.now))) continue
      if (!clashes(d, t, busy, gap)) return { date: d, time: t }
    }
  }
  return { date, time }
}

// Vorlauf, den eine heute geplante Aufgabe mit Uhrzeit mindestens hat.
export const LEAD_MIN = 30

// Uhrzeit heute schon vorbei oder zu knapp: nächste volle Stunde mit Vorlauf (bis 21:00), sonst nächster passender Tag zur geplanten Uhrzeit.
export function notBeforeNow(date: string, time: string, today: string, now: string, opts: { weekend?: boolean } = {}): { date: string, time: string } {
  if (date !== today || minutesOf(time) >= minutesOf(now) + LEAD_MIN) return { date, time }
  const next = Math.ceil((minutesOf(now) + LEAD_MIN) / 60) * 60
  if (next <= minutesOf(LATEST)) return { date, time: timeOf(Math.max(next, minutesOf(EARLIEST))) }
  let d = addDays(date, 1)
  while (opts.weekend === false && weekday(d) >= 6) d = addDays(d, 1)
  return { date: d, time }
}

// Neu geplante Aufgabe (nicht vom Menschen mit Uhrzeit angelegt) nie vor jetzt in der Zeitzone des Arbeitsbereichs.
export async function futureSlot<T extends { workspaceId: string, projectId?: string | null, category: string, dueDate?: string | null, dueTime?: string | null, createdByUserId?: string | null, status?: string }>(db: DbOrTx, input: T): Promise<T> {
  if (!input.dueDate || !input.dueTime || input.createdByUserId || (input.status && (DONE_STATUSES as readonly string[]).includes(input.status))) return input
  const [ws] = await db.select({ timezone: schema.workspaces.timezone }).from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId))
  if (!ws) return input
  const d = today(ws.timezone)
  if (input.dueDate !== d) return input
  const [project] = input.projectId ? await db.select({ rules: schema.projects.rules }).from(schema.projects).where(eq(schema.projects.id, input.projectId)) : []
  const policy = weekendPolicy([project?.rules])
  const slot = notBeforeNow(input.dueDate, input.dueTime, d, nowTime(ws.timezone), { weekend: input.category === 'social' ? policy.social : policy.human })
  if (slot.date === input.dueDate && slot.time === input.dueTime) return input
  return { ...input, dueDate: slot.date, dueTime: slot.time }
}

// Plattformen des aktuellen Entwurfs je Aufgabe (offen oder freigegeben): sie zählen statt des Kanals der Aufgabe.
async function draftPlatforms(db: DbOrTx, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!ids.length) return out
  const rows = await db.select({ taskId: schema.drafts.taskId, platforms: schema.drafts.platforms }).from(schema.drafts)
    .where(and(inArray(schema.drafts.taskId, ids), inArray(schema.drafts.status, ['offen', 'freigegeben']))).orderBy(desc(schema.drafts.version))
  for (const r of rows) {
    if (!out.has(r.taskId) && r.platforms.length) out.set(r.taskId, r.platforms)
  }
  return out
}

async function userMoved(db: DbOrTx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const rows = await db.select({ taskId: schema.activity.taskId }).from(schema.activity)
    .where(and(inArray(schema.activity.taskId, ids), eq(schema.activity.action, 'moved'), eq(schema.activity.actor, 'user')))
  return new Set(rows.map(r => r.taskId!))
}

// Vom Menschen gesetzte Uhrzeit: selbst angelegt mit Uhrzeit, selbst verschoben, Uhrzeit-Experiment oder Meilenstein.
function pinnedTime(t: TaskRow, moved: Set<string>): boolean {
  return (!!t.dueTime && !!t.createdByUserId) || moved.has(t.id) || !!t.experimentId || t.milestone
}

// Hält Social-Posts eines Projekts auf gleichen Plattformen auseinander (Abstand, höchstens Posts je Plattform und Tag). Die automatisch geplante weicht, eine vom Menschen gesetzte Uhrzeit bleibt.
export async function placePost(db: DbOrTx, task: TaskRow, opts: { pinned?: boolean } = {}): Promise<TaskRow> {
  if (task.category !== 'social' || !task.projectId || !task.dueDate || task.status === 'verworfen' || DONE_STATUSES.includes(task.status)) return task
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId))
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, task.workspaceId))
  if (!project || !ws) return task
  const postable = socialTarget(ws, project)?.platforms.filter(p => p.postable).map(p => p.platform) ?? []
  const rows = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, task.projectId), eq(schema.tasks.category, 'social'), ne(schema.tasks.id, task.id), ne(schema.tasks.status, 'verworfen'), gte(schema.tasks.dueDate, task.dueDate), lte(schema.tasks.dueDate, addDays(task.dueDate, 14))))
  const [me, ...placed] = await withChannelPlaces(db, [task, ...rows])
  const drafts = await draftPlatforms(db, [task.id, ...rows.map(r => r.id)])
  const plats = new Map<string, string[]>([[task.id, postPlatforms(me!, postable, drafts.get(task.id))], ...rows.map((r, i) => [r.id, postPlatforms(placed[i]!, postable, drafts.get(r.id))] as [string, string[]])])
  const mine = plats.get(task.id)!
  const others = rows.filter(r => samePlatform(mine, plats.get(r.id)!))
  if (!others.length) return task
  const at = (t: TaskRow): Busy => ({ date: t.dueDate!, time: t.dueTime ?? DEFAULT_POST_TIME, platforms: plats.get(t.id) })
  const gap = POST_GAP_MIN
  const conflict = others.filter(o => clashes(task.dueDate!, task.dueTime ?? DEFAULT_POST_TIME, [at(o)], gap))
  const max = project.setup?.pacing?.perPlatformPerDay ?? null
  const full = dayFull(task.dueDate, others.map(at), max, mine.includes(ALL) ? undefined : mine)
  if (!conflict.length && !full) return task
  const moved = await userMoved(db, [task.id, ...conflict.map(o => o.id)])
  const slotOpts: SlotOpts = { gap, today: today(ws.timezone), now: nowTime(ws.timezone), weekend: weekendPolicy([project.rules]).social, maxPerDay: max, platforms: mine.includes(ALL) ? undefined : mine }
  const iPinned = opts.pinned ?? pinnedTime(task, moved)
  if (!iPinned) {
    const slot = freeSlot(task.dueDate, task.dueTime ?? DEFAULT_POST_TIME, others.map(at), slotOpts)
    if (slot.date === task.dueDate && slot.time === (task.dueTime ?? DEFAULT_POST_TIME)) return task
    return updateTask(db, task, { dueDate: slot.date, dueTime: slot.time }, { type: 'system' }, { spread: false })
  }
  if (!conflict.length) return task
  const busy = [at(task), ...others.filter(o => !conflict.includes(o) || pinnedTime(o, moved)).map(at)]
  for (const o of conflict) {
    if (pinnedTime(o, moved) || DONE_STATUSES.includes(o.status)) continue
    const op = plats.get(o.id)!
    const slot = freeSlot(o.dueDate!, o.dueTime ?? DEFAULT_POST_TIME, busy, { ...slotOpts, platforms: op.includes(ALL) ? undefined : op })
    busy.push({ ...slot, platforms: op })
    await updateTask(db, o, { dueDate: slot.date, dueTime: slot.time }, { type: 'system' }, { spread: false })
  }
  return task
}
