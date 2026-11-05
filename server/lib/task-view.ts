import { and, eq, inArray, like, sql, type SQL } from 'drizzle-orm'
import { OPEN_STATUSES } from '../../shared/utils/domain'
import { mcpApproveConfig, mcpKindOf } from '../../shared/utils/mcp-approve'
import { repliesItself } from '../../shared/utils/listening'
import { isCommunitySweep } from '../../shared/utils/community-sweep'
import { weekendPolicy } from '../../shared/utils/release'
import { taskView, type Clock, type TaskFacts, type TaskView } from '../../shared/utils/task-state'
import { agentReady } from './agent'
import { nowTime, today } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { pendingJobs } from './jobs'
import { goesOut } from './mcp-approve'
import { routeContext } from './route'
import { ownerOf, type TaskRow } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Draft = typeof schema.drafts.$inferSelect

export interface ViewRow extends TaskView {
  draftId: string | null
  draftKind: string | null
  approvedVia: string | null
  busy: boolean
  running: boolean
}

export function clockOf(ws: Pick<Workspace, 'timezone'>): Clock {
  return { today: today(ws.timezone), time: nowTime(ws.timezone) }
}

export async function workspaceOwner(db: DbOrTx, workspaceId: string): Promise<string | null> {
  const rows = await db.select({ userId: schema.memberships.userId, role: schema.memberships.role }).from(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId))
  return rows.find(r => r.role === 'owner')?.userId ?? rows.find(r => r.role === 'admin')?.userId ?? null
}

// Lädt alles, was taskView() braucht, für viele Aufgaben auf einmal.
export async function taskViews(db: DbOrTx, ws: Workspace, tasks: TaskRow[], clock: Clock = clockOf(ws)): Promise<Map<string, ViewRow>> {
  const out = new Map<string, ViewRow>()
  if (!tasks.length) return out
  const ids = tasks.map(t => t.id)
  const drafts = await db.select().from(schema.drafts).where(and(inArray(schema.drafts.taskId, ids), inArray(schema.drafts.status, ['offen', 'freigegeben']))).orderBy(sql`${schema.drafts.version} desc`)
  const open = new Map<string, Draft>()
  const approved = new Map<string, Draft>()
  for (const d of drafts) {
    if (d.status === 'offen' && !open.has(d.taskId)) open.set(d.taskId, d)
    if (d.status === 'freigegeben' && !approved.has(d.taskId)) approved.set(d.taskId, d)
  }
  const openIds = [...open.keys()]
  const infoRows = openIds.length
    ? await db.select({ taskId: schema.taskNotes.taskId, at: schema.taskNotes.createdAt }).from(schema.taskNotes).where(and(inArray(schema.taskNotes.taskId, openIds), eq(schema.taskNotes.byAgent, true), like(schema.taskNotes.text, 'Info nötig:%')))
    : []
  const info = new Set(infoRows.filter(n => n.at.getTime() >= open.get(n.taskId)!.createdAt.getTime() - 2000).map(n => n.taskId))
  const busy = new Set((await pendingJobs(db, ws.id)).filter(j => j.type === 'draft_task' && j.taskId).map(j => j.taskId!))

  const sched = new Map<string, { at: Date | null, running: boolean }>()
  const put = (taskId: string, at: Date | null, running: boolean) => {
    const cur = sched.get(taskId)
    if (!cur || running || (at && (!cur.at || at < cur.at))) sched.set(taskId, { at: running ? at ?? cur?.at ?? null : at, running: running || !!cur?.running })
  }
  for (const r of await db.select({ taskId: schema.socialPosts.taskId, at: schema.socialPosts.scheduledAt, status: schema.socialPosts.status }).from(schema.socialPosts).where(and(inArray(schema.socialPosts.taskId, ids), inArray(schema.socialPosts.status, ['geplant', 'laeuft'])))) put(r.taskId, r.at, r.status === 'laeuft')
  for (const r of await db.select({ taskId: schema.mails.taskId, at: schema.mails.scheduledAt }).from(schema.mails).where(and(inArray(schema.mails.taskId, ids), eq(schema.mails.direction, 'out'), eq(schema.mails.status, 'geplant')))) if (r.taskId) put(r.taskId, r.at, false)
  const approvedIds = [...approved.values()].map(d => d.id)
  if (approvedIds.length) {
    const byDraft = new Map([...approved.values()].map(d => [d.id, d.taskId]))
    const keys = approvedIds.flatMap(id => [`publish_article:${id}`, `publish_article:${id}:retry`])
    for (const j of await db.select({ key: schema.jobs.dedupeKey, at: schema.jobs.runAt, status: schema.jobs.status }).from(schema.jobs).where(and(inArray(schema.jobs.dedupeKey, keys), inArray(schema.jobs.status, ['queued', 'running'])))) {
      const id = j.key?.split(':')[1]
      const taskId = id ? byDraft.get(id) : undefined
      if (taskId) put(taskId, j.at, j.status === 'running')
    }
    for (const j of await db.select({ draftId: sql<string>`${schema.jobs.payload}->>'draftId'`, at: schema.jobs.runAt, status: schema.jobs.status }).from(schema.jobs).where(and(eq(schema.jobs.type, 'listening_reply'), inArray(sql`${schema.jobs.payload}->>'draftId'`, approvedIds), inArray(schema.jobs.status, ['queued', 'running'])))) {
      const taskId = byDraft.get(j.draftId)
      if (taskId) put(taskId, j.at, j.status === 'running')
    }
  }

  const projects = new Map((await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))).map(p => [p.id, p]))
  const weekend = new Map([...projects.values()].map(p => [p.id, weekendPolicy([p.rules]).human]))
  const route = await routeContext(db, ws)
  const mcp = mcpApproveConfig(ws.settings?.mcpApprove)
  const agentOn = agentReady(ws)
  const owner = await workspaceOwner(db, ws.id)
  for (const t of tasks) {
    const project = t.projectId ? projects.get(t.projectId) ?? null : null
    const d = open.get(t.id) ?? approved.get(t.id) ?? null
    const kind = d?.kind ?? t.draftKind ?? 'text'
    const r = route(t)
    const ck = mcpKindOf(t, { kind })
    const facts: TaskFacts = {
      status: t.status,
      dueDate: t.dueDate,
      dueTime: t.dueTime,
      durationMin: t.durationMin,
      category: t.category,
      draftKind: t.draftKind ?? d?.kind ?? null,
      estimateMin: t.estimateMin,
      owner: ownerOf(t, agentOn),
      userId: t.assigneeUserId ?? owner,
      forClaude: t.forClaude,
      draft: open.has(t.id) ? 'open' : approved.has(t.id) ? 'approved' : null,
      info: info.has(t.id),
      busy: busy.has(t.id),
      route: r.route,
      goesOut: goesOut(ws, project, t, { kind } as Draft),
      scheduledAt: sched.get(t.id)?.at?.toISOString() ?? null,
      running: sched.get(t.id)?.running ?? false,
      claudeChecks: !repliesItself(t) && mcp.enabled && !(t.projectId && mcp.offProjects.includes(t.projectId)) && !!ck && mcp.kinds.includes(ck),
      humanWeekend: t.projectId ? weekend.get(t.projectId) ?? false : false,
      sweep: agentOn && isCommunitySweep(t),
    }
    out.set(t.id, { ...taskView(facts, clock), draftId: d?.id ?? null, draftKind: d?.kind ?? null, approvedVia: d?.approvedVia ?? null, busy: busy.has(t.id) && !open.has(t.id), running: sched.get(t.id)?.running ?? false })
  }
  return out
}

// Alle offenen Aufgaben (im Rahmen von cond) mit ihrer Sicht. Grundlage für Dashboard, Freigaben, Menü-Zähler und Morgen-Mail.
export async function openTaskViews(db: DbOrTx, ws: Workspace, cond?: SQL, clock: Clock = clockOf(ws)): Promise<{ task: TaskRow, view: ViewRow }[]> {
  const tasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, ws.id), inArray(schema.tasks.status, OPEN_STATUSES), cond))
    .orderBy(sql`${schema.tasks.dueDate} asc nulls last`, sql`${schema.tasks.dueTime} asc nulls first`, schema.tasks.code)
  const views = await taskViews(db, ws, tasks, clock)
  return tasks.map(task => ({ task, view: views.get(task.id)! }))
}
