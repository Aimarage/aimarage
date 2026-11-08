import { and, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { autoNotes } from '../lib/auto-strategy'
import { addDays, minutesOf } from '../../shared/utils/dates'
import { DONE_STATUSES, OPEN_STATUSES } from '../../shared/utils/domain'
import { markOf } from '../../shared/utils/drafting'
import { workspaceAccessProblems } from '../lib/access-problems'
import { reviewerReleases } from '../lib/ai-reviewer'
import { forYouNow, humanMinutes, taskView, viewMinutes, waitingLater, type Next, type TaskState, type Who } from '../../shared/utils/task-state'
import { CLIENT_ACTIONS } from '../lib/activity'
import { agentReady } from '../lib/agent'
import { now, today } from '../lib/clock'
import type { Db } from '../lib/db'
import { schema } from '../lib/db'
import { previewRecurrences } from '../lib/materialize'
import { listTasks, ownerOf, type TaskRow } from '../lib/tasks'
import { canSeeProject, projectCond, type Access } from '../lib/access'
import { dailyValues, listGoals } from '../lib/goals'
import { routeContext } from '../lib/route'
import { approvedUntil } from '../lib/approval-limit'
import { zonedToUtc } from '../lib/publish'
import { budgetOf, INFO_BUNDLE_MIN } from '../../shared/utils/time-budget'
import { clockOf, openTaskViews, taskViews } from '../lib/task-view'
import { whereLookup } from '../lib/where'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export interface TaskItem {
  id: string
  code: string
  title: string
  projectId: string | null
  category: TaskRow['category']
  status: TaskRow['status']
  dueDate: string | null
  dueTime: string | null
  durationMin: number
  estimateMin: number | null
  prio: TaskRow['prio']
  owner: 'agent' | 'human' | 'none'
  assigneeUserId: string | null
  milestone: boolean
  channel: string | null
  draftKind: TaskRow['draftKind']
  agentBusy: boolean
  openDraftId: string | null
  state: TaskState
  who: Who
  next: Next
  at: string | null
  overdue: boolean
  visibleFrom: string | null
  now: boolean
  platform: string | null
  noTarget?: boolean
  preview?: boolean
  published?: boolean
  forClaude?: boolean
  humanMin?: number
  then?: 'post'
}

export { heldForApproval, routeContext, routeOf, type RouteTask } from '../lib/route'

export async function toItems(db: Db, workspaceId: string, tasks: TaskRow[]): Promise<TaskItem[]> {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
  if (!ws) return []
  const views = await taskViews(db, ws, tasks)
  const doneIds = tasks.filter(t => DONE_STATUSES.includes(t.status)).map(t => t.id)
  const published = new Set(tasks.filter(t => DONE_STATUSES.includes(t.status) && t.postedUrl).map(t => t.id))
  if (doneIds.length) for (const r of await db.selectDistinct({ taskId: schema.taskLinks.taskId }).from(schema.taskLinks).where(inArray(schema.taskLinks.taskId, doneIds))) published.add(r.taskId)
  const where = await whereLookup(db, ws)
  const agentOn = agentReady(ws)
  return tasks.map((t) => {
    const v = views.get(t.id)!
    const w = where(t)
    return {
      id: t.id,
      code: t.code,
      title: t.title,
      projectId: t.projectId,
      category: t.category,
      status: t.status,
      dueDate: t.dueDate,
      dueTime: t.dueTime,
      durationMin: t.durationMin,
      estimateMin: t.estimateMin,
      prio: t.prio,
      owner: ownerOf(t, agentOn),
      assigneeUserId: t.assigneeUserId ?? (v.who === 'you' ? v.userId : null),
      milestone: t.milestone,
      channel: t.channel,
      draftKind: t.draftKind,
      agentBusy: v.busy,
      openDraftId: v.draft && (v.next === 'approve' || v.next === 'review' || v.next === 'answer' || v.next === 'claudeChecks') ? v.draftId : null,
      state: v.state,
      who: v.who,
      next: v.next,
      at: v.at,
      overdue: v.overdue,
      visibleFrom: v.visibleFrom,
      now: v.now,
      humanMin: humanMinutes(v),
      ...(v.then ? { then: v.then } : {}),
      platform: w?.mark ?? markOf(t),
      ...(w?.missing && OPEN_STATUSES.includes(t.status) ? { noTarget: true } : {}),
      ...(published.has(t.id) ? { published: true } : {}),
      ...(t.forClaude ? { forClaude: true } : {}),
    }
  })
}

function previewView(owner: 'agent' | 'human' | 'none', r: { route: 'auto' | 'approve' | 'self', outlet: boolean }, p: { date: string, dueTime: string | null, category: string, draftKind?: string | null }, clock: { today: string, time: string }) {
  const v = taskView({ status: 'geplant', dueDate: p.date, dueTime: p.dueTime, category: p.category, draftKind: p.draftKind ?? null, owner, route: r.route, goesOut: r.outlet }, clock)
  return { state: v.state, who: v.who, next: v.next, at: null, overdue: false, visibleFrom: v.visibleFrom, now: false }
}

export async function calendarView(db: Db, ws: Workspace, project: Project | null, from: string, to: string, access: Access = { all: true, ids: [] }) {
  const tasks = await listTasks(db, { workspaceId: ws.id, projectId: project?.id ?? null, from, to, access })
  const items = await toItems(db, ws.id, tasks.filter(t => t.status !== 'verworfen'))
  const previewFrom = addDays(today(ws.timezone), 1)
  if (to >= previewFrom) {
    const start = from > previewFrom ? from : previewFrom
    const prev = await previewRecurrences(db, ws.id, start, to, project?.id)
    const recIds = [...new Set(prev.map(p => p.recurrenceId))]
    const existing = recIds.length
      ? await db.select({ r: schema.tasks.recurrenceId, k: schema.tasks.occurrenceKey }).from(schema.tasks).where(and(inArray(schema.tasks.recurrenceId, recIds), sql`${schema.tasks.occurrenceKey} >= ${start}`))
      : []
    const keys = new Set(existing.map(t => `${t.r}|${t.k}`))
    const route = await routeContext(db, ws)
    const clock = clockOf(ws)
    for (const p of prev) {
      if (keys.has(`${p.recurrenceId}|${p.date}|${p.projectId ?? 'alle'}`) || !canSeeProject(access, p.projectId)) continue
      const owner = (agentReady(ws) || !p.assigneeUserId) && p.agentStep && (p.draftKind || !p.assigneeUserId) ? 'agent' : p.assigneeUserId ? 'human' : 'none'
      items.push({
        id: `preview:${p.recurrenceId}:${p.date}:${p.projectId ?? 'alle'}`,
        code: '',
        title: p.title,
        projectId: p.projectId,
        category: p.category,
        status: 'geplant',
        dueDate: p.date,
        dueTime: p.dueTime,
        durationMin: p.durationMin,
        estimateMin: null,
        prio: 'P2',
        owner,
        assigneeUserId: p.humanStep ? p.assigneeUserId : null,
        milestone: false,
        channel: null,
        draftKind: null,
        agentBusy: false,
        openDraftId: null,
        ...previewView(owner, route({ ...p, channel: null }), p, clock),
        platform: markOf({ ...p, channel: null }),
        preview: true,
      })
    }
  }
  return { from, to, items }
}

function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null
  return Math.round(((cur - prev) / prev) * 100)
}

export async function kpiSeries(db: Db, projectId: string, key: string, endDay: string, days = 14) {
  const from = addDays(endDay, -(days - 1))
  const byDay = await dailyValues(db, projectId, key, addDays(from, -7), endDay)
  const series: (number | null)[] = []
  for (let i = 0; i < days; i++) series.push(byDay.get(addDays(from, i)) ?? null)
  const value = byDay.get(endDay) ?? null
  const prev = byDay.get(addDays(endDay, -7)) ?? null
  return { value, prev, change: pctChange(value, prev), series }
}

const DONE_ACTIONS: Record<string, keyof DoneCounts> = {
  social_posted: 'posted',
  social_posted_report: 'posted',
  blog_published: 'posted',
  blog_published_report: 'posted',
  mail_sent: 'mails',
  mail_sent_report: 'mails',
  draft_created: 'drafted',
  mcp_approved: 'checked',
  reviewer_approved: 'checked',
  'status:freigegeben': 'approved',
  'status:erledigt': 'done',
}

export interface DoneCounts {
  posted: number
  mails: number
  drafted: number
  checked: number
  approved: number
  done: number
  moved: number
  dropped: number
}
export const DONE_KEYS: (keyof DoneCounts)[] = ['posted', 'mails', 'drafted', 'checked', 'approved', 'done', 'moved', 'dropped']
export type DoneBy = 'ai' | 'claude' | 'you'
export type AiDone = Record<DoneBy, DoneCounts>

const empty = (): DoneCounts => ({ posted: 0, mails: 0, drafted: 0, checked: 0, approved: 0, done: 0, moved: 0, dropped: 0 })

// Was seit gestern 0 Uhr (Zeitzone des Arbeitsbereichs) passiert ist, je Projekt und nach wer: KI, Claude (MCP) oder du.
export async function aiDone(db: Db, ws: Workspace, project: Project | null, access: Access, d: string): Promise<AiDone> {
  const out: AiDone = { ai: empty(), claude: empty(), you: empty() }
  const rows = await db.select({ action: schema.activity.action, actor: schema.activity.actor, detail: schema.activity.detail }).from(schema.activity).where(and(
    eq(schema.activity.workspaceId, ws.id),
    inArray(schema.activity.action, [...Object.keys(DONE_ACTIONS), 'budget_planned']),
    gte(schema.activity.createdAt, zonedToUtc(addDays(d, -1), '00:00', ws.timezone)),
    project ? eq(schema.activity.projectId, project.id) : projectCond(access, schema.activity.projectId),
  ))
  // Verschoben: jede Aufgabe einmal, auch wenn die Planung sie an einem Tag mehrmals weiterschiebt (ältere Einträge ohne ids zählen mit ihrer Zahl).
  const moved = new Set<string>()
  let movedOld = 0
  for (const r of rows) {
    if (r.action === 'budget_planned') {
      const ids = r.detail.ids
      if (Array.isArray(ids)) for (const id of ids) moved.add(String(id))
      else movedOld += Number(r.detail.moved ?? 0)
      out.ai.dropped += Number(r.detail.dropped ?? 0)
      continue
    }
    const by: DoneBy = r.actor === 'mcp' ? 'claude' : r.actor === 'user' ? 'you' : 'ai'
    out[by][DONE_ACTIONS[r.action]!]++
  }
  out.ai.moved = moved.size + movedOld
  return out
}

export async function dashboardView(db: Db, ws: Workspace, project: Project | null, userId: string, access: Access = { all: true, ids: [] }, admin = true) {
  const d = today(ws.timezone)
  const yesterday = addDays(d, -1)
  const projects = project ? [project] : await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), sql`${schema.projects.archivedAt} is null`, projectCond(access, schema.projects.id, false))).orderBy(schema.projects.sortOrder)

  const kpis: { projectId: string, key: string, label: string, value: number | null, prev: number | null, change: number | null, series: (number | null)[] }[] = []
  if (project) {
    for (const k of project.kpis.slice(0, 3)) kpis.push({ projectId: project.id, key: k.key, label: k.label, ...(await kpiSeries(db, project.id, k.key, yesterday)) })
  }
  else {
    for (const p of projects.slice(0, 4)) {
      const k = p.kpis[0] ?? { key: 'visitors', label: 'Besucher' }
      kpis.push({ projectId: p.id, key: k.key, label: k.label, ...(await kpiSeries(db, p.id, k.key, yesterday)) })
    }
  }
  let visitors: number | null = null
  let visitorsPrev: number | null = null
  for (const p of projects) {
    const s = await kpiSeries(db, p.id, 'visitors', yesterday, 1)
    if (s.value !== null) visitors = (visitors ?? 0) + s.value
    if (s.prev !== null) visitorsPrev = (visitorsPrev ?? 0) + s.prev
  }

  const access2 = project ? undefined : projectCond(access, schema.tasks.projectId)
  const all = await openTaskViews(db, ws, project ? eq(schema.tasks.projectId, project.id) : access2)
  const mine = all.filter(r => forYouNow(r.view) && (!r.view.userId || r.view.userId === userId))
  const claude = all.filter(r => r.view.who === 'claude' && r.task.forClaude && r.task.dueDate && r.task.dueDate <= d)
  const overdue = mine.filter(r => r.view.overdue).length
  const accessList = admin ? await workspaceAccessProblems(db, ws, { projectIds: project ? [project.id] : access.all ? null : access.ids }) : []
  const minutes = viewMinutes(mine.map(r => r.view), INFO_BUNDLE_MIN) + accessList.reduce((n, a) => n + a.min, 0)
  const todayItems = await toItems(db, ws.id, [...mine, ...claude].map(r => r.task))
  const done = await aiDone(db, ws, project, access, d)
  const draftRows = mine.filter(r => r.view.who === 'you' && r.view.draft)
  const approvals = draftRows.length
  const approvalId = approvals === 1 ? draftRows[0]!.view.draftId : null
  const until = await approvedUntil(db, ws, d, projects.map(p => p.id))
  // Wie die Abschnitte "Kommt bald" und "Claude prüft" der Freigaben-Seite (dort ohne Filter nach Person).
  const waiting = waitingLater(all.map(r => r.view))
  const afterCheck = mine.filter(r => r.view.then === 'post').map(r => ({ title: r.task.title, time: r.task.dueDate === d ? r.task.dueTime : null, min: r.view.min }))

  const feedWhere = and(eq(schema.activity.workspaceId, ws.id), or(inArray(schema.activity.actor, ['agent', 'mcp']), inArray(schema.activity.action, CLIENT_ACTIONS)), project ? eq(schema.activity.projectId, project.id) : projectCond(access, schema.activity.projectId))
  const feed = await db.select().from(schema.activity).where(feedWhere).orderBy(desc(schema.activity.createdAt)).limit(6)

  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.workspaceId, ws.id)).orderBy(schema.campaigns.startDate).limit(1)
  const [{ n: futureCount } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.tasks).where(and(eq(schema.tasks.workspaceId, ws.id), isNotNull(schema.tasks.dueDate), sql`${schema.tasks.dueDate} > ${d}`, projectCond(access, schema.tasks.projectId)))

  const goals = (await listGoals(db, ws.id, d, { projectId: project?.id ?? null, access })).filter(g => g.targetValue)
  return {
    today: d,
    now: now().toISOString(),
    goals: goals.slice(0, project ? 5 : 6),
    goalsTotal: goals.length,
    kpis,
    kpiDay: yesterday,
    status: { approvals, approvalId, waiting, approvedUntil: until, overdue, minutes, afterCheck, access: accessList, budget: budgetOf(ws.settings, userId), visitors, visitorsChange: pctChange(visitors, visitorsPrev) },
    done,
    today_tasks: todayItems.sort((a, b) => Number(b.overdue) - Number(a.overdue) || `${a.dueDate ?? ''}${a.dueTime ?? ''}`.localeCompare(`${b.dueDate ?? ''}${b.dueTime ?? ''}`)),
    feed: feed.map(f => ({ id: f.id, at: f.createdAt.toISOString(), action: f.action, projectId: f.projectId, taskId: f.taskId, detail: f.detail })),
    campaignStart: campaign?.startDate ?? null,
    futureCount,
    autoStrategy: await autoNotes(db, ws.id, new Date(now().getTime() - 7 * 86_400_000), projects.map(p => p.id)),
    reviewer: (await reviewerReleases(db, ws.id, { onlyStoppable: true, cond: project ? eq(schema.tasks.projectId, project.id) : access2 })).map(r => ({ draftId: r.draftId, projectId: r.projectId, title: r.title, platform: r.platform, releaseAt: r.releaseAt?.toISOString() ?? null })),
  }
}
