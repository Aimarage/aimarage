import { and, asc, desc, eq, inArray, isNull, like, sql, type SQL } from 'drizzle-orm'
import { projectCond, type Access } from './access'
import { canTransition, CATEGORY_CODES, DONE_STATUSES, type Category, type DraftKind, type Prio, type TaskStatus } from '../../shared/utils/domain'
import { logActivity } from './activity'
import type { DbOrTx } from './db'
import { schema } from './db'
import { now } from './clock'
import { enqueueJob } from './jobs'
import { addTaskLinks, dropManualLink } from './task-links'
import { isClaudeTask } from '../../shared/utils/time-budget'
import { isCommunitySweep } from '../../shared/utils/community-sweep'

export type TaskRow = typeof schema.tasks.$inferSelect

export interface NewTask {
  workspaceId: string
  projectId?: string | null
  campaignId?: string | null
  recurrenceId?: string | null
  occurrenceKey?: string | null
  code?: string
  title: string
  description?: string | null
  category: Category
  channel?: string | null
  language?: string | null
  dueDate?: string | null
  dueTime?: string | null
  durationMin?: number
  estimateMin?: number | null
  prio?: Prio
  status?: TaskStatus
  agentStep?: string | null
  humanStep?: string | null
  assigneeUserId?: string | null
  draftKind?: DraftKind | null
  targetUrl?: string | null
  metric?: string | null
  followUpOn?: string | null
  dependsOnId?: string | null
  milestone?: boolean
  createdByUserId?: string | null
  strategyChannel?: string | null
  origin?: string | null
  releaseOk?: boolean
  forClaude?: boolean
}

export async function projectCode(db: DbOrTx, projectId: string | null | undefined): Promise<string> {
  if (!projectId) return 'ALLE'
  const [p] = await db.select({ code: schema.projects.code }).from(schema.projects).where(eq(schema.projects.id, projectId))
  return p?.code ?? 'ALLE'
}

export async function nextTaskCode(db: DbOrTx, workspaceId: string, prefix: string): Promise<string> {
  const rows = await db.select({ code: schema.tasks.code }).from(schema.tasks)
    .where(and(eq(schema.tasks.workspaceId, workspaceId), like(schema.tasks.code, `${prefix}-%`)))
  let max = 0
  for (const r of rows) {
    const n = Number(r.code.slice(prefix.length + 1))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

export const ORDER_MAX = 15

// Kopierfertiger Auftrag an Claude Code oder Entwickler im Repo der Website.
export function websiteOrder(site: string | null, code: string, intro: string, lines: string[]): string {
  const shown = lines.slice(0, ORDER_MAX)
  return [
    'Auftrag für Claude Code oder Entwickler (kopieren):',
    `Im Code der Website${site ? ` ${site}` : ''}: ${intro}`,
    ...shown.map(l => `- ${l}`),
    lines.length > shown.length ? `- und ${lines.length - shown.length} weitere Seiten (gleiche Regel)` : '',
    `Nur das ändern, dann veröffentlichen. Danach Aufgabe ${code} in Aimarage erledigen (MCP: aufgabe_status mit notiz, was gemacht wurde).`,
  ].filter(Boolean).join('\n')
}

export async function createTask(db: DbOrTx, task: NewTask): Promise<TaskRow> {
  const { futureSlot, placePost } = await import('./post-slots')
  const input = await futureSlot(db, task)
  const code = input.code ?? await nextTaskCode(db, input.workspaceId, `${await projectCode(db, input.projectId)}-${CATEGORY_CODES[input.category]}`)
  const [row] = await db.insert(schema.tasks).values({
    ...input,
    code,
    projectId: input.projectId ?? null,
    milestone: input.milestone ?? input.category === 'launch',
    forClaude: input.forClaude ?? isClaudeTask({ category: input.category, origin: input.origin ?? null, description: input.description ?? null, humanStep: input.humanStep ?? null }),
  }).returning()
  if (row!.category !== 'social' || !row!.dueDate || !row!.projectId) return row!
  return placePost(db, row!)
}

export interface TaskPatch {
  title?: string
  description?: string | null
  category?: Category
  channel?: string | null
  language?: string | null
  dueDate?: string | null
  dueTime?: string | null
  durationMin?: number
  estimateMin?: number | null
  prio?: Prio
  status?: TaskStatus
  agentStep?: string | null
  humanStep?: string | null
  assigneeUserId?: string | null
  draftKind?: DraftKind | null
  targetUrl?: string | null
  metric?: string | null
  followUpOn?: string | null
  dependsOnId?: string | null
  milestone?: boolean
  postedUrl?: string | null
  projectId?: string | null
  forClaude?: boolean
  plannedFor?: string | null
  strategyChannel?: string | null
}

export class TransitionError extends Error {}

const TRACKED: (keyof TaskPatch)[] = ['title', 'dueDate', 'dueTime', 'status', 'assigneeUserId', 'prio', 'category', 'projectId', 'postedUrl']

export async function updateTask(db: DbOrTx, task: TaskRow, patch: TaskPatch, actor: { type: 'user' | 'agent' | 'system' | 'mcp', userId?: string | null }, opts: { spread?: boolean } = {}): Promise<TaskRow> {
  if (patch.status && !canTransition(task.status, patch.status)) throw new TransitionError(`Status ${task.status} -> ${patch.status} nicht erlaubt`)
  const set: Partial<typeof schema.tasks.$inferInsert> = { ...patch, updatedAt: now() }
  if (patch.status && patch.status !== task.status) {
    if (patch.status === 'erledigt') set.doneAt = now()
    else if (patch.status !== 'ausgewertet') set.doneAt = null
    if (DONE_STATUSES.includes(patch.status) || patch.status === 'verworfen') {
      await db.update(schema.drafts).set({ status: 'ersetzt' }).where(and(eq(schema.drafts.taskId, task.id), eq(schema.drafts.status, 'offen')))
    }
  }
  if (patch.dueDate === null) set.dueTime = null
  const [row] = await db.update(schema.tasks).set(set).where(eq(schema.tasks.id, task.id)).returning()
  if ('postedUrl' in patch && patch.postedUrl !== task.postedUrl) {
    if (task.postedUrl) await dropManualLink(db, task.id, task.postedUrl)
    if (patch.postedUrl) await addTaskLinks(db, row!, [{ url: patch.postedUrl }])
  }
  if (patch.status === 'verworfen' && task.status !== 'verworfen' && row!.postedUrl && row!.projectId && (task.category === 'content' || task.draftKind === 'article')) {
    await enqueueJob(db, 'withdraw_article', { workspaceId: task.workspaceId, payload: { taskId: task.id }, dedupeKey: `withdraw_article:${task.id}:${now().getTime()}`, maxAttempts: 1 })
  }
  const changes: Record<string, { from: unknown, to: unknown }> = {}
  for (const key of TRACKED) {
    if (key in patch && (patch as Record<string, unknown>)[key] !== (task as Record<string, unknown>)[key]) changes[key] = { from: (task as Record<string, unknown>)[key], to: (patch as Record<string, unknown>)[key] }
  }
  if ((changes.dueDate || changes.dueTime) && row!.status === 'freigegeben' && row!.dueDate) {
    const { syncSchedule } = await import('./schedule-sync')
    await syncSchedule(db, row!)
  }
  if (Object.keys(changes).length) {
    const action = changes.status ? `status:${patch.status}` : (changes.dueDate || changes.dueTime) ? 'moved' : 'updated'
    await logActivity(db, { workspaceId: task.workspaceId, projectId: row!.projectId, taskId: task.id, actor: actor.type, userId: actor.userId ?? null, action, detail: { changes, title: row!.title } })
  }
  if ((changes.status || changes.postedUrl) && DONE_STATUSES.includes(row!.status) && (row!.category === 'content' || row!.draftKind === 'article')) {
    const { releaseLinkedPosts } = await import('./retype')
    await releaseLinkedPosts(db, row!)
  }
  if (opts.spread !== false && row!.category === 'social' && row!.dueDate && row!.projectId && (changes.dueDate || changes.dueTime || changes.category || (changes.status && task.status === 'verworfen'))) {
    const { placePost } = await import('./post-slots')
    return placePost(db, row!, actor.type === 'user' && (changes.dueDate || changes.dueTime) ? { pinned: true } : {})
  }
  return row!
}

export interface TaskFilter {
  workspaceId: string
  projectId?: string | null
  from?: string
  to?: string
  statuses?: TaskStatus[]
  categories?: Category[]
  assignee?: 'agent' | string
  backlog?: boolean
  search?: string
  limit?: number
  access?: Access
}

export function taskWhere(f: TaskFilter): SQL {
  const parts: SQL[] = [eq(schema.tasks.workspaceId, f.workspaceId)]
  if (f.projectId) parts.push(eq(schema.tasks.projectId, f.projectId))
  const scope = f.access && projectCond(f.access, schema.tasks.projectId)
  if (scope) parts.push(scope)
  if (f.from) parts.push(sql`${schema.tasks.dueDate} >= ${f.from}`)
  if (f.to) parts.push(sql`${schema.tasks.dueDate} <= ${f.to}`)
  if (f.backlog === true) parts.push(isNull(schema.tasks.dueDate))
  if (f.backlog === false) parts.push(sql`${schema.tasks.dueDate} is not null`)
  if (f.statuses?.length) parts.push(inArray(schema.tasks.status, f.statuses))
  if (f.categories?.length) parts.push(inArray(schema.tasks.category, f.categories))
  if (f.assignee === 'agent') parts.push(sql`${schema.tasks.agentStep} is not null and ${schema.tasks.status} = 'geplant'`)
  else if (f.assignee) parts.push(eq(schema.tasks.assigneeUserId, f.assignee))
  if (f.search) {
    const q = `%${f.search.toLowerCase()}%`
    parts.push(sql`(lower(${schema.tasks.title}) like ${q} or lower(${schema.tasks.code}) like ${q} or lower(coalesce(${schema.tasks.channel}, '')) like ${q})`)
  }
  return and(...parts)!
}

export async function listTasks(db: DbOrTx, f: TaskFilter): Promise<TaskRow[]> {
  return db.select().from(schema.tasks).where(taskWhere(f))
    .orderBy(sql`${schema.tasks.dueDate} asc nulls last`, sql`${schema.tasks.dueTime} asc nulls first`, asc(schema.tasks.prio), asc(schema.tasks.code))
    .limit(f.limit ?? 2000)
}

export function ownerOf(t: Pick<TaskRow, 'status' | 'agentStep' | 'assigneeUserId' | 'humanStep' | 'draftKind' | 'title' | 'category' | 'targetUrl' | 'origin'>, agentOn = true): 'agent' | 'human' | 'none' {
  if (!agentOn && t.assigneeUserId) return 'human'
  if (agentOn && isCommunitySweep(t)) return 'agent'
  if (t.agentStep && t.status === 'geplant' && (t.draftKind || !t.assigneeUserId)) return 'agent'
  if (t.assigneeUserId) return 'human'
  if (!t.humanStep && t.agentStep) return 'agent'
  return 'none'
}

export async function latestDrafts(db: DbOrTx, taskIds: string[]): Promise<Map<string, typeof schema.drafts.$inferSelect>> {
  const map = new Map<string, typeof schema.drafts.$inferSelect>()
  if (!taskIds.length) return map
  const rows = await db.select().from(schema.drafts).where(inArray(schema.drafts.taskId, taskIds)).orderBy(desc(schema.drafts.version))
  for (const r of rows) if (!map.has(r.taskId)) map.set(r.taskId, r)
  return map
}
