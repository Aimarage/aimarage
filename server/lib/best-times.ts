import { and, desc, eq, gte, inArray, isNotNull, like, sql } from 'drizzle-orm'
import { addDays, timeIn, todayIn, weekday } from '../../shared/utils/dates'
import { DONE_STATUSES } from '../../shared/utils/domain'
import { logActivity } from './activity'
import { now, nowTime, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import { socialTarget } from './publish'
import { projectOwner } from './strategy'
import { createTask } from './tasks'
import { lockedTimeChannels } from './experiments'
import type { TimeSuggest } from './feeds'
import { releaseFocusFor } from './release-focus'
import { oldReleaseHit } from '../../shared/utils/release-focus'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export const MIN_POSTS = 10
export const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

export const DEFAULT_TIMES: Record<string, { days: number[], time: string }> = {
  linkedin: { days: [2, 3, 4], time: '08:30' },
  x: { days: [2, 3, 4], time: '09:00' },
  facebook: { days: [2, 3, 4], time: '09:00' },
  bluesky: { days: [2, 3, 4], time: '10:00' },
  mastodon: { days: [2, 3, 4], time: '10:00' },
  telegram: { days: [2, 3, 4], time: '10:00' },
  instagram: { days: [2, 3, 5], time: '11:00' },
  threads: { days: [2, 3, 4], time: '12:00' },
  youtube: { days: [4, 5, 6], time: '17:00' },
  tiktok: { days: [2, 4, 5], time: '18:00' },
  pinterest: { days: [5, 6, 7], time: '20:00' },
}
const FALLBACK = { days: [2, 3, 4], time: '10:00' }

export interface PlatformTimes {
  platform: string
  posts: number
  source: 'data' | 'default'
  days: number[]
  time: string
}

export interface PostSample {
  platform: string
  postedAt: Date
  score: number
}

export function engagement(m: Record<string, number>): number {
  return (m.likes ?? 0) + 2 * (m.comments ?? 0) + 3 * (m.shares ?? 0) + 2 * (m.clicks ?? 0) + 0.01 * (m.reach ?? 0)
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function hhmm(min: number): string {
  const m = Math.round(min / 15) * 15
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function computeTimes(platform: string, samples: PostSample[], tz: string, min = MIN_POSTS): PlatformTimes {
  const def = DEFAULT_TIMES[platform] ?? FALLBACK
  const own = samples.filter(s => s.platform === platform)
  if (own.length < min) return { platform, posts: own.length, source: 'default', days: def.days, time: def.time }
  const local = own.map((s) => {
    const [h, m] = timeIn(tz, s.postedAt).split(':').map(Number)
    return { day: weekday(todayIn(tz, s.postedAt)), minute: h! * 60 + m!, score: s.score }
  })
  const byDay = new Map<number, number[]>()
  for (const l of local) byDay.set(l.day, [...(byDay.get(l.day) ?? []), l.score])
  const days = [...byDay.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => mean(b[1]) - mean(a[1]) || a[0] - b[0]).slice(0, 3).map(([d]) => d)
  for (const d of def.days) if (days.length < 3 && !days.includes(d)) days.push(d)
  const windows = new Map<number, typeof local>()
  for (const l of local) {
    const w = Math.floor(l.minute / 180)
    windows.set(w, [...(windows.get(w) ?? []), l])
  }
  const best = [...windows.values()].filter(v => v.length >= 2).sort((a, b) => mean(b.map(x => x.score)) - mean(a.map(x => x.score)))[0]
  const time = best ? hhmm(mean(best.map(x => x.minute))) : def.time
  return { platform, posts: own.length, source: 'data', days: days.sort((a, b) => a - b), time }
}

export async function taskScores(db: DbOrTx, taskIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!taskIds.length) return out
  const rows = await db.select({ taskId: schema.results.taskId, metric: schema.results.metric, value: sql<number>`max(${schema.results.value})::float` }).from(schema.results)
    .where(and(inArray(schema.results.taskId, taskIds), inArray(schema.results.metric, ['likes', 'comments', 'shares', 'clicks', 'reach'])))
    .groupBy(schema.results.taskId, schema.results.metric)
  const per = new Map<string, Record<string, number>>()
  for (const r of rows) per.set(r.taskId, { ...per.get(r.taskId), [r.metric]: r.value })
  for (const [id, m] of per) out.set(id, engagement(m))
  return out
}

export async function postSamples(db: DbOrTx, projectId: string, days = 180): Promise<PostSample[]> {
  const since = new Date(now().getTime() - days * 86_400_000)
  const links = await db.select({ taskId: schema.taskLinks.taskId, platform: schema.taskLinks.platform, postedAt: schema.taskLinks.postedAt }).from(schema.taskLinks)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskLinks.taskId))
    .where(and(eq(schema.taskLinks.projectId, projectId), eq(schema.tasks.category, 'social'), isNotNull(schema.taskLinks.platform), gte(schema.taskLinks.postedAt, since)))
  const scores = await taskScores(db, [...new Set(links.map(l => l.taskId))])
  return links.filter(l => scores.has(l.taskId)).map(l => ({ platform: l.platform!, postedAt: l.postedAt, score: scores.get(l.taskId)! }))
}

export async function bestTimes(db: DbOrTx, ws: Workspace, project: Project): Promise<PlatformTimes[]> {
  const samples = await postSamples(db, project.id)
  const platforms = [...new Set([...(socialTarget(ws, project)?.platforms.filter(p => p.postable).map(p => p.platform) ?? []), ...samples.map(s => s.platform)])]
  return platforms.map(p => computeTimes(p, samples, ws.timezone)).sort((a, b) => b.posts - a.posts || a.platform.localeCompare(b.platform))
}

export function primaryTimes(list: PlatformTimes[]): PlatformTimes | null {
  return list.find(x => x.source === 'data') ?? list[0] ?? null
}

export function suggestSlot(times: PlatformTimes | null, date: string, nowHm: string, todayIso: string, mode: 'soon' | 'best', preferred: string | null = null): { date: string, time: string | null } {
  const time = times?.source === 'data' ? times.time : preferred ?? times?.time ?? null
  if (!time) return { date, time: null }
  const days = times?.days ?? []
  for (let i = 0; i < 8; i++) {
    const d = addDays(date, i)
    if (d === todayIso && time <= nowHm) continue
    if (mode === 'soon' || !days.length || days.includes(weekday(d))) return { date: d, time }
  }
  return { date: addDays(date, 1), time }
}

export function timeSuggester(db: DbOrTx, ws: Workspace, project: Project, mode: 'soon' | 'best' = 'soon'): TimeSuggest {
  return async (date, preferred) => suggestSlot(primaryTimes(await bestTimes(db, ws, project)), date, nowTime(ws.timezone), today(ws.timezone), mode, preferred)
}

export async function applyBestTimes(db: Db, ws: Workspace, project: Project): Promise<string[]> {
  const st = await db.select().from(schema.strategies).where(and(eq(schema.strategies.projectId, project.id), eq(schema.strategies.status, 'aktiv'))).orderBy(desc(schema.strategies.version)).limit(1)
  const cur = st[0]
  if (!cur) return []
  const best = primaryTimes(await bestTimes(db, ws, project))
  if (!best || best.source !== 'data') return []
  const locked = await lockedTimeChannels(db, project.id)
  const changed: string[] = []
  const channels = cur.channels.map((c) => {
    if (c.category !== 'social' || !c.active || locked.has(c.key)) return c
    const n = c.days.length
    const days = n && n <= best.days.length ? best.days.slice(0, n).map(d => DAY_CODES[d - 1]!) : c.days
    if (c.time === best.time && days.join() === c.days.join()) return c
    changed.push(`${c.name}: ${days.join(', ')} ${best.time}`)
    return { ...c, time: best.time, days }
  })
  if (!changed.length) return []
  await db.update(schema.strategies).set({ channels }).where(eq(schema.strategies.id, cur.id))
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'best_times_applied', detail: { title: changed.join('; ') }, at: now() })
  return changed
}

export const EVERGREEN_MIN_DAYS = 42
export const EVERGREEN_FACTOR = 1.5

export async function proposeEvergreen(db: Db, ws: Workspace, project: Project, opts: { draft?: boolean } = {}): Promise<{ code: string, title: string } | null> {
  const d = today(ws.timezone)
  const weekAgo = new Date(now().getTime() - 7 * 86_400_000)
  const [recent] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.projectId, project.id), like(schema.tasks.origin, 'evergreen:%'), gte(schema.tasks.createdAt, weekAgo))).limit(1)
  if (recent) return null
  const since = new Date(now().getTime() - 365 * 86_400_000)
  const cutoff = new Date(now().getTime() - EVERGREEN_MIN_DAYS * 86_400_000)
  const posted = await db.select({ taskId: schema.taskLinks.taskId, at: sql<Date>`min(${schema.taskLinks.postedAt})` }).from(schema.taskLinks)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskLinks.taskId))
    .where(and(eq(schema.taskLinks.projectId, project.id), eq(schema.tasks.category, 'social'), inArray(schema.tasks.status, DONE_STATUSES), gte(schema.taskLinks.postedAt, since)))
    .groupBy(schema.taskLinks.taskId)
  const scores = await taskScores(db, posted.map(p => p.taskId))
  const scored = posted.filter(p => scores.has(p.taskId)).map(p => ({ taskId: p.taskId, at: new Date(p.at), score: scores.get(p.taskId)! }))
  if (scored.length < 5) return null
  const avg = mean(scored.map(s => s.score))
  const used = new Set((await db.select({ origin: schema.tasks.origin }).from(schema.tasks).where(and(eq(schema.tasks.projectId, project.id), like(schema.tasks.origin, 'evergreen:%')))).map(r => r.origin!.slice('evergreen:'.length)))
  const focus = await releaseFocusFor(db, project.id, d)
  let pick: (typeof scored)[number] | null = null
  let orig: typeof schema.tasks.$inferSelect | undefined
  let draft: typeof schema.drafts.$inferSelect | undefined
  for (const cand of scored.filter(s => s.at <= cutoff && s.score >= avg * EVERGREEN_FACTOR && s.score > 0 && !used.has(s.taskId)).sort((a, b) => b.score - a.score).slice(0, 5)) {
    const [o] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, cand.taskId))
    if (!o || o.origin?.startsWith('evergreen:')) return null
    const [dr] = await db.select().from(schema.drafts).where(and(eq(schema.drafts.taskId, o.id), inArray(schema.drafts.status, ['freigegeben', 'offen', 'ersetzt']))).orderBy(sql`case when ${schema.drafts.status} = 'freigegeben' then 0 else 1 end`, desc(schema.drafts.version)).limit(1)
    if (!dr) return null
    if (oldReleaseHit(`${o.title}\n${dr.subject ?? ''}\n${dr.body}`, focus)) continue
    pick = cand
    orig = o
    draft = dr
    break
  }
  if (!pick || !orig || !draft) return null
  const when = await timeSuggester(db, ws, project, 'best')(addDays(d, 1), null)
  const t = await createTask(db, {
    workspaceId: ws.id,
    projectId: project.id,
    title: `Neu aufgelegt: ${orig.title.replace(/^Neu aufgelegt: /, '')}`.slice(0, 200),
    description: [
      `Dieser Beitrag vom ${pick.at.toISOString().slice(0, 10)} lief deutlich besser als der Schnitt (Wert ${Math.round(pick.score)}, Schnitt ${Math.round(avg)}).`,
      'Neu auflegen, aber nicht 1:1 kopieren: neuer Einstieg, andere Formulierung, wenn möglich ein aktueller Bezug, gleiche Kernaussage und gleicher Link.',
      `Ursprünglicher Text:\n${draft.body.slice(0, 2000)}`,
    ].join('\n'),
    category: 'social',
    channel: orig.channel,
    language: orig.language,
    dueDate: when.date,
    dueTime: when.time,
    agentStep: 'Erfolgreichen Beitrag überarbeitet neu auflegen',
    humanStep: 'Prüfen und freigeben',
    assigneeUserId: orig.assigneeUserId ?? await projectOwner(db, project.id),
    draftKind: 'post',
    targetUrl: orig.targetUrl ?? draft.targetUrl,
    origin: `evergreen:${orig.id}`,
  })
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, taskId: t.id, actor: 'agent', action: 'evergreen_proposed', detail: { title: t.title }, at: now() })
  if (opts.draft !== false) await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: t.id, hold: true }, dedupeKey: `draft_task:${t.id}:${d}` })
  return { code: t.code, title: t.title }
}

export async function bestTimesDigest(db: DbOrTx, ws: Workspace, project: Project): Promise<string | null> {
  const list = (await bestTimes(db, ws, project)).filter(x => x.source === 'data')
  if (!list.length) return null
  return `Beste Posting-Zeiten aus eigenen Zahlen: ${list.map(x => `${x.platform} ${x.days.map(d => DAY_CODES[d - 1]).join('/')} ${x.time} (${x.posts} Beiträge)`).join('; ')}.`
}
