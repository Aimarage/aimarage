import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, sql } from 'drizzle-orm'
import { addDays, diffDays, isValidIso, startOfWeek } from '../../../shared/utils/dates'
import { OPEN_STATUSES, roleAtLeast, STATUSES, type TaskStatus } from '../../../shared/utils/domain'
import { canSeeProject, projectCond } from '../access'
import { logActivity } from '../activity'
import { isArticle } from '../retype'
import { type ChatActor, conversationMessages, findConversation, isBusy, postUserMessage, QUEUED, runToolDirect, runTurn, ToolFailure, type TurnDeps } from '../chat'
import { today } from '../clock'
import type { Db } from '../db'
import { schema } from '../db'
import { listGoals } from '../goals'
import { cancelPosts, withUtm } from '../publish'
import { activeStrategy, pendingProposal, strategyHistory } from '../strategy'
import { experimentsView, MAX_EXTENSIONS, MIN_PER_ARM, strategyWeeks, THRESHOLD } from '../experiments'
import { listTasks as queryTasks, updateTask as patchTask } from '../tasks'
import { endRecurrence, loadRecurrence } from '../recurrences'
import { applyDraftAction, DraftStateError } from '../../services/drafts'
import { calendarView } from '../../services/views'
import { taskViews } from '../task-view'
import { statsConfigured, utmSummary } from '../traffic'
import { loadHistory } from '../history'
import { linksOf } from '../task-links'
import { mailInfo } from '../mail'
import { searchSummary } from '../search-console'
import { latestAudit } from '../seo-audit'
import { agentReady } from '../agent'
import { LlmError } from '../llm'
import { approvedToday, approveViaMcp, draftStamp, McpApproveError, mcpConfig, reviewForMcp } from '../mcp-approve'
import type { FetchLike } from '../outlets'
import { talkAboutTask, talkBusy, taskTalk } from '../talk'
import { draftChecks } from '../../../shared/utils/talk'
import { linkLabel } from '../../../shared/utils/links'
import { PLATFORM_RULES } from '../../../shared/utils/social'
import { forYouNow, viewMinutes } from '../../../shared/utils/task-state'
import { checkKind, isOpenStatus, openFirst } from '../../../shared/utils/task-check'
import { safeHttpUrl } from '../../../shared/utils/url'
import { aiAfterEdit } from '../../../shared/utils/ai-label'
import { checkAndClose } from '../task-check'

type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

const NO_OUTSIDE = 'Über API/MCP wird nichts gepostet oder gesendet: Entwürfe landen in den Freigaben und werden in Aimarage freigegeben.'

function needWrite(actor: ChatActor): void {
  if (!roleAtLeast(actor.role, 'member')) throw new ApiError(403, 'Keine Berechtigung zum Ändern (Token nur zum Lesen oder Rolle Betrachter)')
}

async function tool(db: Db, actor: ChatActor, name: string, args: Record<string, unknown>, deps: TurnDeps = {}): Promise<Record<string, unknown>> {
  try {
    const out = await runToolDirect(db, actor, name, Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)), deps)
    const r = (out ?? {}) as Record<string, unknown>
    if (r.ok === false) throw new ApiError(400, String(r.reason ?? 'Nicht möglich'))
    return r
  }
  catch (err) {
    if (!(err instanceof ToolFailure)) throw err
    const m = err.message
    throw new ApiError(/Berechtigung|Nur Admins/.test(m) ? 403 : /nicht gefunden/i.test(m) ? 404 : 400, m)
  }
}

const clean = (v: string): string => v.replace(/[\u2013\u2014]/g, '-')

async function visibleProjects(db: Db, actor: ChatActor): Promise<Project[]> {
  const rows = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, actor.workspace.id), isNull(schema.projects.archivedAt))).orderBy(asc(schema.projects.sortOrder))
  return rows.filter(p => canSeeProject(actor.access, p.id))
}

export async function findProject(db: Db, actor: ChatActor, ref: string | null | undefined): Promise<Project> {
  const q = (ref ?? '').trim().toLowerCase()
  if (!q) throw new ApiError(400, 'Projekt fehlt')
  const list = await visibleProjects(db, actor)
  const hit = list.find(p => p.slug === q || p.name.toLowerCase() === q || p.code.toLowerCase() === q) ?? list.find(p => p.name.toLowerCase().includes(q))
  if (!hit) throw new ApiError(404, `Projekt "${ref}" nicht gefunden. Vorhanden: ${list.map(p => p.slug).join(', ') || 'keine'}`)
  return hit
}

async function optionalProject(db: Db, actor: ChatActor, ref: string | null | undefined): Promise<Project | null> {
  return ref?.trim() ? findProject(db, actor, ref) : null
}

function projectInfo(p: Project) {
  return {
    slug: p.slug,
    name: p.name,
    code: p.code,
    url: p.url,
    description: p.description,
    languages: p.languages,
    state: p.setup?.state ?? 'ready',
    rules: p.rules?.trim() || null,
    maxPostsPerPlatformPerDay: p.setup?.pacing?.perPlatformPerDay ?? null,
  }
}

function slugMap(list: Project[]): Map<string | null, string> {
  return new Map<string | null, string>([[null, 'alle'], ...list.map(p => [p.id, p.slug] as [string, string])])
}

function taskOut(t: Task, slugs: Map<string | null, string>) {
  return { code: t.code, title: t.title, project: slugs.get(t.projectId) ?? null, date: t.dueDate, time: t.dueTime, status: t.status, category: t.category, channel: t.channel, draftKind: t.draftKind, ...(t.forClaude ? { forClaude: true } : {}) }
}

// Website-/Code-Aufgaben, die Claude (Code) statt des Menschen erledigt.
export async function claudeTasks(db: Db, actor: ChatActor, project?: string | null) {
  const p = await optionalProject(db, actor, project)
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, actor.workspace.id),
    eq(schema.tasks.forClaude, true),
    inArray(schema.tasks.status, OPEN_STATUSES),
    p ? eq(schema.tasks.projectId, p.id) : undefined,
  )).orderBy(schema.tasks.dueDate, schema.tasks.prio, schema.tasks.code).limit(50)
  const slugs = slugMap(await visibleProjects(db, actor))
  return {
    hint: 'Auftrag steht in description. Umsetzen, veröffentlichen, dann mit aufgabe_status auf erledigt setzen.',
    tasks: rows.filter(t => canSeeProject(actor.access, t.projectId)).map(t => ({ ...taskOut(t, slugs), prio: t.prio, targetUrl: t.targetUrl, description: t.description })),
  }
}

async function loadTaskByCode(db: Db, actor: ChatActor, code: string): Promise<Task> {
  const c = code.trim().slice(0, 40)
  const [t] = c ? await db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, actor.workspace.id), ilike(schema.tasks.code, c.replace(/[%_\\]/g, '\\$&')))) : []
  if (!t || !canSeeProject(actor.access, t.projectId)) throw new ApiError(404, `Aufgabe ${c} nicht gefunden`)
  return t
}

async function rulesOf(db: Db, projectId: string | null): Promise<string | null> {
  if (!projectId) return null
  const [p] = await db.select({ rules: schema.projects.rules }).from(schema.projects).where(eq(schema.projects.id, projectId))
  return p?.rules?.trim() || null
}

export async function me(db: Db, actor: ChatActor, extra: { scope: string, via: string }) {
  const [u] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, actor.userId))
  return { user: u ?? null, workspace: { name: actor.workspace.name, timezone: actor.workspace.timezone }, scope: extra.scope, via: extra.via, today: today(actor.workspace.timezone), postLive: !!actor.workspace.settings?.publishLive, sendLive: !!actor.workspace.settings?.sendLive, note: NO_OUTSIDE }
}

export async function listProjects(db: Db, actor: ChatActor) {
  return (await visibleProjects(db, actor)).map(projectInfo)
}

export async function projectStatus(db: Db, actor: ChatActor, ref: string) {
  const p = await findProject(db, actor, ref)
  const ov = await tool(db, actor, 'get_overview', { project: p.slug })
  const d = today(actor.workspace.timezone)
  const from = startOfWeek(d)
  const to = addDays(from, 6)
  const week = await queryTasks(db, { workspaceId: actor.workspace.id, projectId: p.id, from, to, access: actor.access })
  const live = week.filter(t => t.status !== 'verworfen')
  const done = live.filter(t => t.status === 'erledigt' || t.status === 'ausgewertet')
  const open = live.filter(t => !done.includes(t))
  const res = await db.select({ metric: schema.results.metric, value: sql<number>`sum(${schema.results.value})::float` }).from(schema.results)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.results.taskId))
    .where(and(eq(schema.tasks.projectId, p.id), gte(schema.results.measuredOn, addDays(d, -6)), lte(schema.results.measuredOn, d)))
    .groupBy(schema.results.metric)
  const slugs = slugMap([p])
  const views = await taskViews(db, actor.workspace, open)
  const mine = [...views.values()].filter(forYouNow)
  return {
    project: projectInfo(p),
    week: {
      from,
      to,
      today: d,
      done: done.length,
      open: open.length,
      overdue: [...views.values()].filter(v => v.overdue).length,
      forYouToday: { minutes: viewMinutes(mine), codes: open.filter(t => forYouNow(views.get(t.id)!)).map(t => t.code) },
      tasks: live.map(t => taskOut(t, slugs)),
    },
    goals: ov.goals,
    strategy: ov.strategy,
    proposalPending: ov.proposalPending,
    openApprovals: ov.approvals,
    resultsLast7Days: Object.fromEntries(res.map(r => [r.metric, r.value])),
    profile: ov.project,
  }
}

export async function weekPlan(db: Db, actor: ChatActor, q: { project?: string | null, from?: string | null, days?: number | null }) {
  const p = await optionalProject(db, actor, q.project)
  const d = today(actor.workspace.timezone)
  const from = q.from && isValidIso(q.from) ? q.from : startOfWeek(d)
  const days = Math.min(62, Math.max(1, Math.round(q.days ?? 7)))
  const to = addDays(from, days - 1)
  const cal = await calendarView(db, actor.workspace, p, from, to, actor.access)
  const slugs = slugMap(await visibleProjects(db, actor))
  const items = cal.items
    .sort((a, b) => `${a.dueDate}${a.dueTime ?? ''}`.localeCompare(`${b.dueDate}${b.dueTime ?? ''}`))
    .map(i => ({ code: i.code || null, title: i.title, project: slugs.get(i.projectId) ?? null, date: i.dueDate, time: i.dueTime, status: i.status, category: i.category, owner: i.owner, who: i.who, next: i.next, overdue: i.overdue, forYouFrom: i.who === 'you' || i.then ? i.visibleFrom : null, ...(i.then ? { thenYouPost: true, forYouMin: i.humanMin } : {}), openDraftId: i.openDraftId, preview: !!i.preview }))
  return { from, to, today: d, items }
}

export async function searchTasks(db: Db, actor: ChatActor, q: { project?: string | null, from?: string | null, to?: string | null, status?: string | null, search?: string | null, limit?: number | null }) {
  const p = await optionalProject(db, actor, q.project)
  const statuses = (q.status ?? '').split(',').map(x => x.trim()).filter((x): x is TaskStatus => (STATUSES as readonly string[]).includes(x))
  if (q.from && q.to && q.from <= q.to && diffDays(q.to, q.from) > 366) throw new ApiError(400, 'Zeitraum höchstens 1 Jahr')
  const rows = await queryTasks(db, {
    workspaceId: actor.workspace.id,
    projectId: p?.id ?? null,
    from: q.from && isValidIso(q.from) ? q.from : undefined,
    to: q.to && isValidIso(q.to) ? q.to : undefined,
    statuses: statuses.length ? statuses : undefined,
    search: q.search?.trim().slice(0, 80) || undefined,
    access: actor.access,
    limit: Math.min(200, Math.max(1, q.limit ?? 50)),
  })
  const slugs = slugMap(await visibleProjects(db, actor))
  return rows.map(t => taskOut(t, slugs))
}

export async function getTask(db: Db, actor: ChatActor, code: string) {
  const t = await loadTaskByCode(db, actor, code)
  const drafts = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t.id)).orderBy(desc(schema.drafts.version)).limit(5)
  const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, t.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(20)
  const results = await db.select().from(schema.results).where(eq(schema.results.taskId, t.id)).orderBy(desc(schema.results.measuredOn))
  const slugs = slugMap(await visibleProjects(db, actor))
  return {
    ...taskOut(t, slugs),
    description: t.description,
    agentStep: t.agentStep,
    humanStep: t.humanStep,
    targetUrl: t.targetUrl,
    postedUrl: t.postedUrl,
    links: (await linksOf(db, t)).map(l => ({ platform: linkLabel(l.platform, l.url), url: l.url, at: l.postedAt })),
    followUpOn: t.followUpOn,
    rules: await rulesOf(db, t.projectId),
    drafts: drafts.map(x => ({ id: x.id, version: x.version, status: x.status, kind: x.kind, byAgent: x.byAgent, aiGenerated: x.aiGenerated, createdAt: x.createdAt.toISOString() })),
    notes: notes.map(n => ({ text: n.text, byAgent: n.byAgent, at: n.createdAt.toISOString() })),
    results: results.map(r => ({ metric: r.metric, value: r.value, day: r.measuredOn, source: r.source })),
    mail: await mailInfo(db, t.id),
  }
}

export interface TaskInput {
  project: string
  title: string
  category: string
  date?: string | null
  time?: string | null
  description?: string | null
  draft?: boolean | null
}

export async function createTask(db: Db, actor: ChatActor, input: TaskInput, deps: TurnDeps = {}) {
  needWrite(actor)
  const p = await findProject(db, actor, input.project)
  const r = await tool(db, actor, 'create_task', { project: p.slug, title: input.title, category: input.category, date: input.date ?? undefined, time: input.time ?? undefined, description: input.description ? clean(input.description) : undefined, draft: input.draft ?? undefined }, deps)
  return { ...(await getTask(db, actor, String(r.code))), note: r.draft ? `Der Agent schreibt einen Entwurf. ${NO_OUTSIDE}` : null }
}

export async function planRelease(db: Db, actor: ChatActor, input: { project: string, title: string, kind: string, releaseDate: string, link?: string | null, items?: string | null, document?: string | null, platforms?: string[] | null, start?: string | null, every?: number | null, time?: string | null, press?: boolean | null, create?: boolean | null }, deps: TurnDeps = {}) {
  needWrite(actor)
  const p = await findProject(db, actor, input.project)
  const r = await tool(db, actor, 'plan_release', { project: p.slug, title: clean(input.title), kind: input.kind, release_date: input.releaseDate, link: input.link ?? undefined, items: input.items ? clean(input.items) : undefined, document: input.document ?? undefined, platforms: input.platforms ?? undefined, start: input.start ?? undefined, every: input.every ?? undefined, time: input.time ?? undefined, press: input.press ?? undefined, create: input.create ?? undefined }, deps)
  return r.created ? { ...r, note: `Angelegt. Entwürfe landen in den Freigaben. ${NO_OUTSIDE}` } : r
}

export async function updateTask(db: Db, actor: ChatActor, code: string, input: { date?: string | null, time?: string | null, title?: string | null, status?: string | null, force?: boolean | null }) {
  needWrite(actor)
  const t = await loadTaskByCode(db, actor, code)
  if (input.status === 'erledigt' && !input.force && isOpenStatus(t.status) && checkKind(t)) {
    const r = await checkAndClose(db, actor.workspace, t, { type: 'mcp', userId: actor.userId }, { search: true })
    const pruefung = { erledigt: r.ok, punkte: openFirst(r.items).map(i => `${i.done ? 'ok' : 'offen'}: ${i.text}`) }
    if (!r.closed) return { ...(await getTask(db, actor, t.code)), abgehakt: false, pruefung, hinweis: 'Laut Prüfung noch nicht erledigt, die Aufgabe bleibt offen. Erst die offenen Punkte beheben und veröffentlichen; nur wenn sicher erledigt, mit force: true abhaken.' }
    return { ...(await getTask(db, actor, t.code)), abgehakt: true, pruefung }
  }
  await tool(db, actor, 'update_task', { code: t.code, date: input.date ?? undefined, time: input.time === null ? '' : input.time ?? undefined, title: input.title ?? undefined, status: input.status ?? undefined })
  return getTask(db, actor, t.code)
}

// Ziel einer Aufgabe setzen: Link (Thread, Subreddit, Verzeichnis, Seite) und/oder Ort im Kanal (z.B. r/aiMusic). Offene Entwürfe bekommen den Link mit.
export async function setTaskTarget(db: Db, actor: ChatActor, code: string, input: { url?: string | null, place?: string | null }) {
  needWrite(actor)
  const t = await loadTaskByCode(db, actor, code)
  if (!isOpenStatus(t.status)) throw new ApiError(409, `Aufgabe ist ${t.status}`)
  const patch: { targetUrl?: string | null, channel?: string | null } = {}
  if (input.url !== undefined) {
    const raw = input.url?.trim() ?? ''
    const url = raw ? safeHttpUrl(raw) : null
    if (raw && !url) throw new ApiError(400, 'Ziel-Link muss mit http:// oder https:// beginnen')
    patch.targetUrl = url
  }
  if (input.place !== undefined) patch.channel = clean(input.place ?? '').trim() || null
  if (!Object.keys(patch).length) throw new ApiError(400, 'ziel_url oder ort angeben')
  await patchTask(db, t, patch, { type: 'user', userId: actor.userId })
  if ('targetUrl' in patch) await db.update(schema.drafts).set({ targetUrl: patch.targetUrl ?? null }).where(and(eq(schema.drafts.taskId, t.id), eq(schema.drafts.status, 'offen')))
  return getTask(db, actor, t.code)
}

export async function endSeries(db: Db, actor: ChatActor, code: string) {
  needWrite(actor)
  const t = await loadTaskByCode(db, actor, code)
  const rec = t.recurrenceId ? await loadRecurrence(db, actor.workspace.id, actor.access, t.recurrenceId) : null
  if (!rec) throw new ApiError(400, `Aufgabe ${t.code} gehört zu keiner Serie`)
  if (!rec.active) return { ok: true, serie: rec.title, schonBeendet: true, verworfen: [] }
  const r = await endRecurrence(db, rec, today(actor.workspace.timezone), { type: 'user', userId: actor.userId })
  return { ok: true, serie: rec.title, verworfen: r.discarded }
}

export async function goals(db: Db, actor: ChatActor, ref: string) {
  const p = await findProject(db, actor, ref)
  const rows = await listGoals(db, actor.workspace.id, today(actor.workspace.timezone), { projectId: p.id })
  return rows.map(g => ({ id: g.id, label: g.label, metricKey: g.metricKey, mode: g.mode, target: g.targetValue, deadline: g.deadline, active: g.active, current: g.progress.current, pct: g.progress.pct, expectedPct: g.progress.expectedPct, state: g.progress.state }))
}

export async function setGoal(db: Db, actor: ChatActor, ref: string, input: { id?: string | null, label?: string | null, target?: number | null, deadline?: string | null, metricKey?: string | null, mode?: string | null, active?: boolean | null }) {
  needWrite(actor)
  const p = await findProject(db, actor, ref)
  const r = await tool(db, actor, 'set_goal', { project: p.slug, goal_id: input.id ?? undefined, label: input.label ?? undefined, target: input.target ?? undefined, deadline: input.deadline ?? undefined, metric_key: input.metricKey ?? undefined, mode: input.mode ?? undefined, active: input.active ?? undefined })
  const id = String(r.goal_id ?? (r.goal as { id?: string } | undefined)?.id ?? input.id ?? '')
  return (await goals(db, actor, p.slug)).find(g => g.id === id) ?? r
}

export async function recordMetric(db: Db, actor: ChatActor, ref: string, input: { key: string, value: number, day?: string | null }) {
  needWrite(actor)
  const p = await findProject(db, actor, ref)
  return tool(db, actor, 'record_number', { project: p.slug, metric_key: input.key, value: input.value, day: input.day ?? undefined })
}

export async function strategy(db: Db, actor: ChatActor, ref: string) {
  const p = await findProject(db, actor, ref)
  const active = await activeStrategy(db, p.id)
  const pending = await pendingProposal(db, p.id)
  const history = await strategyHistory(db, p.id, 8)
  const chan = (s: NonNullable<typeof active>) => s.channels.map(c => ({ key: c.key, name: c.name, category: c.category, weight: c.weight, active: c.active, why: c.why, places: c.places ?? [], topics: c.topics ?? [] }))
  return {
    project: p.slug,
    weightScale: '1 = 1x/Monat, 2 = alle 2 Wochen, 3 = 1x/Woche, 4 = 2x/Woche, 5 = 3x/Woche, 6 = werktags',
    message: p.setup?.analysis?.positioning ?? null,
    audiences: p.setup?.analysis?.audiences ?? [],
    active: active ? { version: active.version, summary: active.summary, channels: chan(active) } : null,
    proposal: pending ? { version: pending.version, summary: pending.summary, channels: chan(pending), changes: pending.changes } : null,
    history: history.map(h => ({ version: h.version, status: h.status, kind: h.kind, summary: h.summary, at: h.createdAt.toISOString(), changes: h.changes.map(c => ({ name: c.name, change: c.change, from: c.from, to: c.to, reason: c.reason })) })),
  }
}

export async function experiments(db: Db, actor: ChatActor, ref: string) {
  const p = await findProject(db, actor, ref)
  const v = await experimentsView(db, p.id)
  const weeks = await strategyWeeks(db, p.id, 8)
  return {
    project: p.slug,
    rules: `Höchstens ein Experiment je Projekt gleichzeitig. Bewertung: Mittelwert je Beitrag (Takt: je Woche), mindestens ${MIN_PER_ARM} gemessene Beiträge je Variante, ab ${Math.round(THRESHOLD * 100)} % Unterschied besser bzw. schlechter, sonst kein klarer Unterschied; zu wenig Daten = verlängern (höchstens ${MAX_EXTENSIONS}x).`,
    current: v.current,
    results: v.recent,
    insights: v.insights.map(i => i.text),
    weeks: weeks.map(w => ({ week: w.week, version: w.version, posts: w.posts, measured: w.measured, reach: w.reach, interactions: w.interactions, clicks: w.clicks, visits: w.visits, signups: w.signups, purchases: w.purchases, costEur: w.costEur })),
  }
}

export async function adjustChannel(db: Db, actor: ChatActor, ref: string, input: { channel: string, change: string, category?: string | null, reason?: string | null }) {
  needWrite(actor)
  const p = await findProject(db, actor, ref)
  return tool(db, actor, 'adjust_strategy', { project: p.slug, channel: input.channel, change: input.change, category: input.category ?? undefined, reason: input.reason ?? undefined })
}

export async function channelDetails(db: Db, actor: ChatActor, ref: string, input: { channel: string, name?: string | null, places?: string[] | null, topics?: string[] | null, why?: string | null }) {
  needWrite(actor)
  const p = await findProject(db, actor, ref)
  return tool(db, actor, 'update_channel', { project: p.slug, channel: input.channel, name: input.name ?? undefined, places: input.places ?? undefined, topics: input.topics ?? undefined, why: input.why ?? undefined })
}

export async function approvals(db: Db, actor: ChatActor, ref?: string | null) {
  const p = await optionalProject(db, actor, ref)
  const rows = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.workspaceId, actor.workspace.id), eq(schema.drafts.status, 'offen'), p ? eq(schema.tasks.projectId, p.id) : projectCond(actor.access, schema.tasks.projectId)))
    .orderBy(asc(schema.tasks.dueDate), desc(schema.drafts.createdAt))
    .limit(100)
  const props = await db.select({ st: schema.strategies, p: schema.projects }).from(schema.strategies)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.strategies.projectId))
    .where(and(eq(schema.strategies.workspaceId, actor.workspace.id), eq(schema.strategies.status, 'vorschlag'), sql`coalesce(${schema.projects.setup}->>'state', 'ready') <> 'onboarding'`, p ? eq(schema.strategies.projectId, p.id) : projectCond(actor.access, schema.strategies.projectId)))
  const projects = await visibleProjects(db, actor)
  const slugs = slugMap(projects)
  const ws = actor.workspace
  const cfg = mcpConfig(ws)
  const drafts = []
  for (const r of rows) {
    const review = await reviewForMcp(db, ws, r.task, r.draft, projects.find(x => x.id === r.task.projectId) ?? null)
    drafts.push({ draftId: r.draft.id, code: r.task.code, title: r.task.title, project: slugs.get(r.task.projectId) ?? null, category: r.task.category, kind: r.draft.kind, version: r.draft.version, stand: review.stand, byAgent: r.draft.byAgent, aiGenerated: r.draft.aiGenerated, dueDate: r.task.dueDate, dueTime: r.task.dueTime, subject: r.draft.subject, preview: r.draft.body.slice(0, 160), infoNeeded: review.infoNeeded.length ? review.infoNeeded : null, mcpAllowed: review.allowed, blockers: review.blockers, hints: review.hints, links: review.links })
  }
  const pending = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.workspaceId, ws.id), eq(schema.drafts.status, 'freigegeben'), eq(schema.drafts.approvedVia, 'mcp'), gte(schema.drafts.releaseAt, new Date()), p ? eq(schema.tasks.projectId, p.id) : projectCond(actor.access, schema.tasks.projectId)))
  return {
    drafts,
    inObjectionPeriod: pending.map(r => ({ draftId: r.draft.id, code: r.task.code, title: r.task.title, releaseAt: r.draft.releaseAt?.toISOString() ?? null })),
    strategyProposals: props.map(r => ({ project: r.p.slug, summary: r.st.summary, changes: r.st.changes.map(c => ({ name: c.name, change: c.change })) })),
    mcpApprove: cfg.enabled
      ? { enabled: true, thisKey: !!actor.canApprove, kinds: cfg.kinds, delayMin: cfg.delayMin, perDay: cfg.perDay, remainingToday: Math.max(0, cfg.perDay - await approvedToday(db, ws)) }
      : { enabled: false },
    note: actor.canApprove && cfg.enabled
      ? 'Freigeben über das Werkzeug freigeben: nur mcpAllowed-Entwürfe, vorher entwurf_lesen, stand mitgeben, Prüfung begründen. Mails nur als Antwort an den Absender einer eingegangenen Mail (Art Mail-Antworten), Erstmails, Kosten, Strategie und Konten nur in Aimarage. Info nötig: mit aufgabe_antworten lösen.'
      : 'Freigeben, Posten und Senden nur in Aimarage selbst. Info nötig: mit aufgabe_gespraech lesen und mit aufgabe_antworten beantworten.',
  }
}

async function loadDraft(db: Db, actor: ChatActor, ref: { id?: string | null, code?: string | null }) {
  if (ref.id) {
    if (!/^[0-9a-f-]{36}$/i.test(ref.id)) throw new ApiError(404, 'Entwurf nicht gefunden')
    const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
      .where(and(eq(schema.drafts.id, ref.id), eq(schema.tasks.workspaceId, actor.workspace.id)))
    if (!row || !canSeeProject(actor.access, row.task.projectId)) throw new ApiError(404, 'Entwurf nicht gefunden')
    return row
  }
  if (!ref.code) throw new ApiError(400, 'Entwurf-ID oder Aufgaben-Code nötig')
  const task = await loadTaskByCode(db, actor, ref.code)
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version)).limit(1)
  if (!draft) throw new ApiError(404, `Aufgabe ${task.code} hat noch keinen Entwurf`)
  return { draft, task }
}

export async function readDraft(db: Db, actor: ChatActor, ref: { id?: string | null, code?: string | null }) {
  const { draft, task } = await loadDraft(db, actor, ref)
  const slugs = slugMap(await visibleProjects(db, actor))
  const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(10)
  return {
    id: draft.id,
    version: draft.version,
    status: draft.status,
    kind: draft.kind,
    byAgent: draft.byAgent,
    aiGenerated: draft.aiGenerated,
    subject: draft.subject,
    recipient: draft.recipient,
    targetUrl: draft.targetUrl,
    body: draft.body,
    platforms: draft.platforms,
    variants: draft.variants,
    media: draft.media.map(m => ({ name: m.name, mime: m.mime })),
    task: taskOut(task, slugs),
    rules: await rulesOf(db, task.projectId),
    notes: notes.map(n => n.text),
    stand: draftStamp(draft),
  }
}

export async function approveDraft(db: Db, actor: ChatActor, ref: { id?: string | null, code?: string | null, stand: string, reason: string }, fetchImpl?: FetchLike) {
  needWrite(actor)
  const { draft, task } = await loadDraft(db, actor, ref)
  try {
    const r = await approveViaMcp(db, actor.workspace, { userId: actor.userId, role: actor.role, canApprove: !!actor.canApprove }, { draftId: draft.id, stand: ref.stand, reason: ref.reason }, fetchImpl)
    return { ok: true, ...r, note: r.goesOut ? `Geht frühestens ${r.releaseAt} raus. Bis dahin kann die Person in Aimarage stoppen. Hauptschalter gelten unverändert.` : 'Freigegeben. Veröffentlichen macht die Person selbst.' }
  }
  catch (err) {
    if (err instanceof McpApproveError) throw new ApiError(err.status, err.message)
    throw err
  }
}

async function infoQuestions(db: Db, task: Task): Promise<string[]> {
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version)).limit(1)
  if (!draft || draft.status !== 'offen') return []
  const notes = await db.select({ id: schema.taskNotes.id, text: schema.taskNotes.text, byAgent: schema.taskNotes.byAgent, createdAt: schema.taskNotes.createdAt }).from(schema.taskNotes)
    .where(and(eq(schema.taskNotes.taskId, task.id), eq(schema.taskNotes.byAgent, true)))
  return draftChecks(notes, draft.createdAt).filter(c => c.kind === 'info').map(c => c.text)
}

export async function taskConversation(db: Db, actor: ChatActor, code: string) {
  const task = await loadTaskByCode(db, actor, code)
  const view = await taskTalk(db, actor.workspace, task)
  const last = view.lines.filter(l => l.kind !== 'version').at(-1)
  return {
    code: task.code,
    title: task.title,
    status: task.status,
    draft: view.draft,
    infoNeeded: await infoQuestions(db, task),
    openQuestion: last?.who === 'agent' && (last.kind === 'ask' || last.kind === 'question') ? last.text : null,
    writing: view.writing,
    canTalk: view.canTalk,
    lines: view.lines.map(l => ({ who: l.who, kind: l.kind, text: l.text, at: l.at })),
    rules: await rulesOf(db, task.projectId),
  }
}

export async function answerTask(db: Db, actor: ChatActor, code: string, text: string, deps: TurnDeps = {}) {
  needWrite(actor)
  const task = await loadTaskByCode(db, actor, code)
  if (!agentReady(actor.workspace)) throw new ApiError(409, 'Agent nicht konfiguriert')
  if (talkBusy(task.id)) throw new ApiError(409, 'Agent antwortet noch')
  try {
    const r = await talkAboutTask(db, actor.workspace, task, actor.userId, text, deps.llmFetch as typeof fetch | undefined, { via: 'mcp' })
    return { ...r, note: r.revising ? 'Der Agent schreibt eine neue Fassung (Entwurf bleibt in den Freigaben, nichts geht automatisch raus). Später mit aufgabe_gespraech oder freigaben_liste nachsehen.' : NO_OUTSIDE }
  }
  catch (err) {
    if (err instanceof LlmError) throw new ApiError(err.code === 'network' ? 504 : 502, `Agent-Antwort fehlgeschlagen: ${err.message.slice(0, 200)}`)
    throw err
  }
}

// Plattformen eines gespeicherten Entwurfs: ausdrückliche Liste, sonst bestimmen die mitgegebenen Fassungen sie (neue kommt dazu, weggelassene fällt weg), sonst bleibt die bisherige.
export function draftPlatformList(kind: string, platforms: string[] | null | undefined, variantKeys: string[] | null, last: string[]): string[] {
  const known = (list: string[]) => [...new Set(list.map(p => p.trim().toLowerCase()).filter(p => p in PLATFORM_RULES))]
  if (platforms) return known(platforms)
  if (kind !== 'article' && variantKeys?.length) {
    const list = known(variantKeys)
    if (list.length) return list
  }
  return last
}

export async function saveDraft(db: Db, actor: ChatActor, code: string, input: { body: string, subject?: string | null, recipient?: string | null, targetUrl?: string | null, platforms?: string[] | null, variants?: Record<string, string> | null }, opts: { ai?: boolean } = {}) {
  needWrite(actor)
  const task = await loadTaskByCode(db, actor, code)
  if (task.status === 'erledigt' || task.status === 'ausgewertet' || task.status === 'verworfen') throw new ApiError(409, `Aufgabe ist ${task.status}`)
  const body = clean(input.body).trim()
  if (!body) throw new ApiError(400, 'Text fehlt')
  const saved = await db.transaction(async (tx) => {
    const [last] = await tx.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version)).limit(1)
    await tx.update(schema.drafts).set({ status: 'ersetzt' }).where(and(eq(schema.drafts.taskId, task.id), inArray(schema.drafts.status, ['offen', 'freigegeben'])))
    const kind = isArticle(task) ? 'article' : last?.kind ?? task.draftKind ?? 'text'
    const variants = Object.fromEntries(Object.entries(input.variants ?? last?.variants ?? {}).filter(([, v]) => v.trim()).map(([k, v]) => [k.trim().toLowerCase(), clean(v)]))
    const text = await withUtm(tx, task, { body, variants })
    const platforms = draftPlatformList(kind, input.platforms, input.variants ? Object.keys(variants) : null, last?.platforms ?? [])
    const [d] = await tx.insert(schema.drafts).values({
      taskId: task.id,
      version: (last?.version ?? 0) + 1,
      kind,
      subject: input.subject === undefined ? last?.subject ?? null : input.subject,
      recipient: input.recipient === undefined ? last?.recipient ?? null : input.recipient,
      targetUrl: input.targetUrl === undefined ? last?.targetUrl ?? null : input.targetUrl,
      body: text.body,
      variant: last?.variant ?? null,
      platforms,
      variants: text.variants,
      media: last?.media ?? [],
      status: 'offen',
      byAgent: false,
      aiGenerated: !!opts.ai || aiAfterEdit(last, text.body),
      createdByUserId: actor.userId,
    }).returning()
    await cancelPosts(tx, task.id)
    if (task.status === 'geplant' || task.status === 'freigegeben') await tx.update(schema.tasks).set({ status: 'entwurf_fertig', updatedAt: new Date() }).where(eq(schema.tasks.id, task.id))
    await logActivity(tx, { workspaceId: actor.workspace.id, projectId: task.projectId, taskId: task.id, actor: 'user', userId: actor.userId, action: 'draft_edited', detail: { title: task.title, version: d!.version, via: 'api' } })
    return { id: d!.id, replatformed: platforms.join(',') !== (last?.platforms ?? []).join(',') }
  })
  if (task.category === 'social' && saved.replatformed) {
    const [cur] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    if (cur) {
      const { placePost } = await import('../post-slots')
      await placePost(db, cur)
    }
  }
  const id = saved.id
  return { ...(await readDraft(db, actor, { id })), note: NO_OUTSIDE }
}

export async function rejectDraft(db: Db, actor: ChatActor, id: string, reason?: string | null, dropTask?: boolean | null) {
  needWrite(actor)
  const { draft } = await loadDraft(db, actor, { id })
  try {
    const r = await applyDraftAction(db, actor.workspace, actor.userId, draft.id, 'reject', { reason: reason?.slice(0, 2000) ?? null, dropTask })
    if (!r) throw new ApiError(404, 'Entwurf nicht gefunden')
    await cancelPosts(db, r.taskId)
    return { ok: true, id: draft.id, status: 'verworfen', aufgabe: r.taskDropped ? 'verworfen' : 'geplant' }
  }
  catch (err) {
    if (err instanceof DraftStateError) throw new ApiError(409, err.message)
    throw err
  }
}

export async function results(db: Db, actor: ChatActor, ref: string, q: { from?: string | null, to?: string | null }) {
  const p = await findProject(db, actor, ref)
  const d = today(actor.workspace.timezone)
  const to = q.to && isValidIso(q.to) ? q.to : d
  const from = q.from && isValidIso(q.from) ? q.from : addDays(to, -29)
  if (from > to || diffDays(to, from) > 366) throw new ApiError(400, 'Zeitraum ungültig (höchstens 1 Jahr)')
  const metrics = await db.select().from(schema.metrics).where(and(eq(schema.metrics.projectId, p.id), gte(schema.metrics.day, from), lte(schema.metrics.day, to))).orderBy(asc(schema.metrics.key), asc(schema.metrics.day)).limit(2000)
  const taskResults = await db.select({ r: schema.results, code: schema.tasks.code, title: schema.tasks.title, category: schema.tasks.category, channel: schema.tasks.strategyChannel }).from(schema.results)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.results.taskId))
    .where(and(eq(schema.tasks.projectId, p.id), gte(schema.results.measuredOn, from), lte(schema.results.measuredOn, to)))
    .orderBy(desc(schema.results.measuredOn)).limit(500)
  const series: Record<string, { day: string, value: number }[]> = {}
  for (const m of metrics) (series[m.key] ??= []).push({ day: m.day, value: m.value })
  return {
    project: p.slug,
    from,
    to,
    metrics: series,
    taskResults: taskResults.map(x => ({ code: x.code, title: x.title, category: x.category, channel: x.channel, metric: x.r.metric, value: x.r.value, day: x.r.measuredOn, source: x.r.source })),
    goals: await goals(db, actor, p.slug),
  }
}

export async function history(db: Db, actor: ChatActor, ref: string, q: { from?: string | null, to?: string | null }) {
  const p = await findProject(db, actor, ref)
  const d = today(actor.workspace.timezone)
  const to = q.to && isValidIso(q.to) ? q.to : d
  const from = q.from && isValidIso(q.from) ? q.from : addDays(to, -29)
  if (from > to || diffDays(to, from) > 366) throw new ApiError(400, 'Zeitraum ungültig (höchstens 1 Jahr)')
  const h = await loadHistory(db, { workspaceId: actor.workspace.id, scope: eq(schema.tasks.projectId, p.id), from, to, timezone: actor.workspace.timezone })
  return {
    project: p.slug,
    from,
    to,
    total: h.total,
    perDay: h.perDay.filter(x => x.n),
    entries: h.entries.map(e => ({ code: e.code, title: e.title, category: e.category, day: e.day, at: e.at, links: e.links.map(l => ({ platform: l.label, url: l.url })) })),
  }
}

export async function traffic(db: Db, actor: ChatActor, ref: string, q: { from?: string | null, to?: string | null }) {
  const p = await findProject(db, actor, ref)
  const d = today(actor.workspace.timezone)
  const to = q.to && isValidIso(q.to) ? q.to : d
  const from = q.from && isValidIso(q.from) ? q.from : addDays(to, -29)
  if (from > to || diffDays(to, from) > 400) throw new ApiError(400, 'Zeitraum ungültig (höchstens 400 Tage)')
  const s = await utmSummary(db, actor.workspace.id, [p.id], from, to)
  const stats = p.setup?.stats
  return {
    project: p.slug,
    from,
    to,
    currency: 'EUR',
    configured: statsConfigured(stats),
    lastSync: stats?.lastSync ?? null,
    error: stats?.error ?? null,
    totals: s.totals,
    sources: s.sources.map(x => ({ ...x, campaigns: x.campaigns.map(c => ({ ...c, task: c.task ? { code: c.task.code, title: c.task.title, strategyChannel: c.task.strategyChannel } : null })) })),
  }
}

export async function searchTerms(db: Db, actor: ChatActor, ref: string, q: { from?: string | null, to?: string | null }) {
  const p = await findProject(db, actor, ref)
  const d = today(actor.workspace.timezone)
  const to = q.to && isValidIso(q.to) ? q.to : addDays(d, -1)
  const from = q.from && isValidIso(q.from) ? q.from : addDays(to, -27)
  if (from > to || diffDays(to, from) > 400) throw new ApiError(400, 'Zeitraum ungültig (höchstens 400 Tage)')
  const g = p.setup?.google
  const b = p.setup?.bing
  const s = g?.property || b?.site ? await searchSummary(db, p.id, from, to) : null
  const audit = await latestAudit(db, p.id)
  return {
    project: p.slug,
    from,
    to,
    connected: !!(g?.property || b?.site),
    property: g?.property ?? null,
    lastSync: g?.lastSync ?? null,
    error: g?.error ?? null,
    bing: { connected: !!b?.site && !b.off, site: b?.site ?? null, lastSync: b?.lastSync ?? null, error: b?.error ?? null },
    note: 'Zahlen sind Google (Search Console) und Bing (Webmaster Tools) zusammen, je Quelle unter bySource. Google liefert mit 2-3 Tagen Verzögerung, Bing Suchbegriffe und Seiten je Woche.',
    clicks: s?.clicks ?? 0,
    impressions: s?.impressions ?? 0,
    position: s?.position ?? null,
    bySource: s?.bySource ?? [],
    top: s?.top ?? [],
    chances: s?.chances ?? [],
    dropped: s?.dropped ?? [],
    seoCheck: audit ? { checkedAt: audit.checkedAt, pages: audit.pages.length, error: audit.error, problems: audit.issues.slice(0, 20).map(i => ({ severity: i.severity, url: i.url, problem: i.label })) } : null,
  }
}

export async function agentLog(db: Db, actor: ChatActor, q: { project?: string | null, limit?: number | null }) {
  const p = await optionalProject(db, actor, q.project)
  const limit = Math.min(100, Math.max(1, q.limit ?? 30))
  const runs = await db.select({ run: schema.agentRuns, taskProject: schema.tasks.projectId }).from(schema.agentRuns)
    .leftJoin(schema.tasks, eq(schema.tasks.id, schema.agentRuns.taskId))
    .where(and(eq(schema.agentRuns.workspaceId, actor.workspace.id), p ? sql`coalesce(${schema.agentRuns.projectId}, ${schema.tasks.projectId}) = ${p.id}` : undefined))
    .orderBy(desc(schema.agentRuns.startedAt)).limit(limit * 2)
  const feed = await db.select().from(schema.activity)
    .where(and(eq(schema.activity.workspaceId, actor.workspace.id), p ? eq(schema.activity.projectId, p.id) : projectCond(actor.access, schema.activity.projectId)))
    .orderBy(desc(schema.activity.createdAt)).limit(limit)
  const slugs = slugMap(await visibleProjects(db, actor))
  return {
    runs: runs.filter(r => canSeeProject(actor.access, r.run.projectId ?? r.taskProject)).slice(0, limit).map(({ run: r, taskProject }) => ({ job: r.job, status: r.status, project: slugs.get(r.projectId ?? taskProject) ?? null, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, summary: r.summary, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costEur: r.costEur })),
    activity: feed.map(f => ({ at: f.createdAt.toISOString(), actor: f.actor, action: f.action, project: slugs.get(f.projectId) ?? null, detail: f.detail })),
  }
}

export async function talkToAgent(db: Db, actor: ChatActor, input: { message: string, project?: string | null }, deps: TurnDeps = {}) {
  needWrite(actor)
  const p = await optionalProject(db, actor, input.project)
  const text = input.message.trim().slice(0, 8000)
  if (!text) throw new ApiError(400, 'Nachricht fehlt')
  const conv = (await findConversation(db, actor, p?.id ?? null, { create: true }))!
  if (isBusy(conv.id)) throw new ApiError(409, 'Agent antwortet gerade noch, bitte gleich nochmal')
  const before = (await conversationMessages(db, conv.id, 1)).at(-1)?.seq ?? 0
  await postUserMessage(db, actor, conv, text)
  await runTurn(db, actor, conv.id, deps)
  const rows = (await conversationMessages(db, conv.id, 40)).filter(m => m.seq > before)
  const tools = rows.flatMap(m => (m.toolCalls ?? []).map(c => c.name))
  const reply = rows.filter(m => m.role === 'assistant' && m.content.trim()).map(m => m.content.trim()).join('\n\n')
  return { project: p?.slug ?? null, reply: reply || 'Keine Antwort.', toolsUsed: [...new Set(tools)], note: NO_OUTSIDE }
}

export async function chatHistory(db: Db, actor: ChatActor, ref?: string | null, limit = 30) {
  const p = await optionalProject(db, actor, ref)
  const conv = await findConversation(db, actor, p?.id ?? null)
  if (!conv) return { project: p?.slug ?? null, messages: [] }
  const rows = await conversationMessages(db, conv.id, Math.min(100, Math.max(1, limit)))
  return { project: p?.slug ?? null, busy: isBusy(conv.id), messages: rows.filter(m => m.role !== 'tool' && m.role !== QUEUED && m.content.trim()).map(m => ({ role: m.role, text: m.content, at: m.createdAt.toISOString() })) }
}
