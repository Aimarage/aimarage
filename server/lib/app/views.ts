import { and, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm'
import { addDays, daysUntil, startOfWeek, weekday } from '../../../shared/utils/dates'
import { ALL_SLUG, DONE_STATUSES } from '../../../shared/utils/domain'
import { markOf } from '../../../shared/utils/drafting'
import { replySourceOf } from '../../../shared/utils/reply-source'
import { SWEEP_PROBLEM } from '../../../shared/utils/community-sweep'
import { forYouNow, waitingLater, type TaskView, type Waiting } from '../../../shared/utils/task-state'
import { shortDay } from '../approval-limit'
import { projectCond } from '../access'
import { draftLists, recentlyDone } from '../approval-lists'
import { reviewerReleases } from '../ai-reviewer'
import { today } from '../clock'
import { config } from '../config'
import { schema } from '../db'
import { taskViews, openTaskViews } from '../task-view'
import { utmSummary } from '../traffic'
import { whereLookup } from '../where'
import { kpiSeries } from '../../services/views'
import { AppError, visibleProjects, type AppCtx } from './core'
import { appSafeText } from './safe'

type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type Draft = typeof schema.drafts.$inferSelect

export type Lang = 'de' | 'en'
export const langOf = (c: AppCtx): Lang => (c.s.user.locale === 'en' ? 'en' : 'de')
const tx = (l: Lang, de: string, en: string) => (l === 'en' ? en : de)
const pctText = (l: Lang, p: number) => (l === 'en' ? `${p}%` : `${p} %`)

export interface AppProject { id: string, name: string, initials: string, color: string | null }
export type AppWho = 'you' | 'agent' | 'claude'
export interface AppTodo { id: string, title: string, minutes: number, kind: 'approvals' | 'question' | 'task', detail?: string | null, taskId?: string | null, projectId?: string | null, approvalId?: string | null }
export interface AppProjectValue { id: string, name: string, color: string | null, visitors: number, change: string }
export interface AppOriginal { place: string, title: string, text: string, url: string | null, author: string | null, at: string | null, age: string | null }
export interface AppApproval {
  id: string
  taskId: string
  projectId: string | null
  platform: string | null
  title: string
  headline: string
  place: string | null
  text: string
  original: AppOriginal | null
  state: 'pending' | 'approved' | 'rejected'
  canApprove: boolean
  due: string | null
  time: string | null
  webUrl: string
  // Steht noch bei "Claude prüft"; freigeben geht trotzdem.
  claudeChecks?: boolean
  // Abschnitt der Liste wie im Web: Zu tun (yours), Bald dran, Claude prüft, Geht automatisch raus, Erledigt.
  group?: 'yours' | 'soon' | 'claude' | 'outgoing' | 'done'
  // Der Agent hat eine Rückfrage, Antwort im Aufgaben-Chat.
  infoNeeded?: boolean
  // Bei Antworten: warum wir darauf antworten (Begründung des Agenten).
  why: string | null
  // Von der KI geschrieben (Kennzeichnung "KI-Entwurf").
  aiGenerated?: boolean
  // Vom KI-Prüfer freigegeben und noch nicht raus ("Geht raus"): Stoppen möglich.
  byReviewer?: boolean
  releaseAt?: string | null
}
export interface AppStat { label: string, value: number, change: string, isPositive: boolean, series: { label: string, value: number }[] }

export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  const s = words.length > 1 ? words[0]![0]! + words[1]![0]! : name.trim().slice(0, 2)
  return s.toUpperCase()
}

export function appProject(p: Project): AppProject {
  return { id: p.slug, name: p.name, initials: initials(p.name), color: p.color ?? null }
}

export async function appProjects(c: AppCtx): Promise<AppProject[]> {
  return (await visibleProjects(c)).map(appProject)
}

function scope(c: AppCtx, project: Project | null) {
  return project ? eq(schema.tasks.projectId, project.id) : projectCond(c.access, schema.tasks.projectId)
}

async function scopeProjects(c: AppCtx, project: Project | null): Promise<Project[]> {
  return project ? [project] : visibleProjects(c)
}

function pct(cur: number, prev: number): number | null {
  if (!prev) return null
  return Math.round(((cur - prev) / prev) * 100)
}

function changeText(l: Lang, cur: number, prev: number, unit: 'pct' | 'abs' = 'pct'): { change: string, isPositive: boolean } {
  if (unit === 'abs') {
    const d = cur - prev
    return { change: d === 0 ? tx(l, 'wie letzte Woche', 'same as last week') : `${d > 0 ? '+' : ''}${d}`, isPositive: d > 0 }
  }
  const p = pct(cur, prev)
  if (p === null) return { change: cur ? tx(l, 'neu', 'new') : '', isPositive: cur > 0 }
  return { change: `${p > 0 ? '+' : ''}${pctText(l, p)}`, isPositive: p > 0 }
}

const safeDetail = (l: Lang, text: string | null) => (text ? appSafeText(text, l) : null)

const sum = (xs: (number | null)[]) => xs.reduce<number>((n, x) => n + (x ?? 0), 0)

// Besucher je Tag (bis gestern), über alle Projekte summiert.
async function visitorDays(c: AppCtx, projects: Project[], days: number): Promise<number[]> {
  const end = addDays(today(c.s.workspace.timezone), -1)
  const out = Array.from({ length: days }, () => 0)
  for (const p of projects) {
    const s = await kpiSeries(c.db, p.id, 'visitors', end, days)
    s.series.forEach((v, i) => { out[i]! += v ?? 0 })
  }
  return out
}

const DAY_SHORT: Record<Lang, string[]> = { de: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }

export async function weekStat(c: AppCtx, project: Project | null): Promise<AppStat> {
  const l = langOf(c)
  const days = await visitorDays(c, await scopeProjects(c, project), 14)
  const cur = sum(days.slice(7))
  const prev = sum(days.slice(0, 7))
  const end = addDays(today(c.s.workspace.timezone), -1)
  const series = days.slice(7).map((value, i) => ({ label: DAY_SHORT[l][weekday(addDays(end, i - 6)) - 1]!, value }))
  const p = pct(cur, prev)
  const change = p === null ? '' : p >= 0 ? tx(l, `${p} % mehr als letzte Woche`, `${p}% more than last week`) : tx(l, `${-p} % weniger als letzte Woche`, `${-p}% less than last week`)
  return { label: tx(l, 'Besucher, letzte 7 Tage', 'Visitors, last 7 days'), value: cur, change, isPositive: (p ?? 0) > 0, series }
}

async function activityCount(c: AppCtx, project: Project | null, actions: string[], fromDay: string, toDay: string): Promise<number> {
  const [r] = await c.db.select({ n: sql<number>`count(*)::int` }).from(schema.activity).where(and(
    eq(schema.activity.workspaceId, c.s.workspace.id),
    inArray(schema.activity.action, actions),
    sql`${schema.activity.createdAt} >= ${fromDay}::date and ${schema.activity.createdAt} < (${toDay}::date + 1)`,
    project ? eq(schema.activity.projectId, project.id) : projectCond(c.access, schema.activity.projectId),
  ))
  return r?.n ?? 0
}

const POSTED = ['social_posted', 'social_posted_report', 'blog_published', 'blog_published_report', 'mail_sent', 'mail_sent_report']

// Wer laut Sicht dran ist: du (auch selbst posten nach Claudes Prüfung), Claude (Website-Aufgabe oder Prüfung) oder der Agent.
export function whoOf(v: Pick<TaskView, 'who' | 'then'>): AppWho | null {
  if (v.who === 'you' || v.then === 'post') return 'you'
  if (v.who === 'claude') return 'claude'
  if (v.who === 'ai') return 'agent'
  return null
}

// Eine Zeile unter "Heute zu tun": was Claude und der Agent heute statt dir erledigen.
export function aiTodayText(l: Lang, claude: number, agent: number): string | null {
  const tasks = (n: number) => n === 1 ? tx(l, '1 Aufgabe', '1 task') : tx(l, `${n} Aufgaben`, `${n} tasks`)
  const web = (n: number) => n === 1 ? tx(l, '1 Website-Aufgabe', '1 website task') : tx(l, `${n} Website-Aufgaben`, `${n} website tasks`)
  if (claude && agent) return tx(l, `Claude erledigt heute ${web(claude)}, der Agent ${tasks(agent)}.`, `Claude handles ${web(claude)} today, the agent ${tasks(agent)}.`)
  if (claude) return tx(l, `Claude erledigt heute ${web(claude)}.`, `Claude handles ${web(claude)} today.`)
  if (agent) return tx(l, `Der Agent erledigt heute ${tasks(agent)}.`, `The agent handles ${tasks(agent)} today.`)
  return null
}

// Statt "nichts zu tun": heute nichts fällig, wie viele später auf dich warten (Bald dran) und wie viele Claude prüft, je mit nächstem Tag.
export function waitingText(l: Lang, d: string, w: Waiting): string {
  const head = weekday(d) >= 6 ? tx(l, 'Wochenende, heute nichts fällig.', 'Weekend, nothing due today.') : tx(l, 'Heute nichts fällig.', 'Nothing due today.')
  const dayOf = (x: string | null) => {
    if (!x) return ''
    const k = daysUntil(d, x)
    return k <= 0 ? tx(l, 'heute', 'today') : k === 1 ? tx(l, 'morgen', 'tomorrow') : k < 7 ? shortDay(x, l).split(' ')[0]! : shortDay(x, l)
  }
  const parts = [head]
  if (w.soon) {
    const n = w.soon === 1 ? tx(l, '1 Freigabe wartet auf dich', '1 approval waiting for you') : tx(l, `${w.soon} Freigaben warten auf dich`, `${w.soon} approvals waiting for you`)
    const info = !w.info ? '' : w.info === 1 ? tx(l, ', 1 braucht Infos von dir', ', 1 needs info from you') : tx(l, `, ${w.info} brauchen Infos von dir`, `, ${w.info} need info from you`)
    const day = dayOf(w.next)
    parts.push(`${n}${info}${day ? tx(l, ` (nächste fällig ${day})`, ` (next due ${day})`) : ''}.`)
  }
  if (w.claude) {
    const one = w.claude === 1
    const n = one ? tx(l, 'Claude prüft 1 Entwurf', 'Claude is checking 1 draft') : tx(l, `Claude prüft ${w.claude} Entwürfe`, `Claude is checking ${w.claude} drafts`)
    const day = dayOf(w.claudeNext)
    const next = !day ? '' : one ? tx(l, ` (fällig ${day})`, ` (due ${day})`) : tx(l, ` (nächster fällig ${day})`, ` (next due ${day})`)
    const rest = one
      ? tx(l, ', ist er am Fälligkeitstag nicht freigegeben, bist du dran.', '; if it is not approved by its due day, it is your turn.')
      : tx(l, ', was am Fälligkeitstag nicht freigegeben ist, gibst du frei.', '; whatever is not approved by its due day, you approve.')
    parts.push(`${n}${next}${rest}`)
  }
  return parts.join(' ')
}

export async function appDashboard(c: AppCtx, project: Project | null) {
  const l = langOf(c)
  const d = today(c.s.workspace.timezone)
  const projects = await scopeProjects(c, project)
  const days = await visitorDays(c, projects, 14)
  const vCur = sum(days.slice(7))
  const vPrev = sum(days.slice(0, 7))
  const pCur = await activityCount(c, project, POSTED, addDays(d, -6), d)
  const pPrev = await activityCount(c, project, POSTED, addDays(d, -13), addDays(d, -7))
  const numbers = [
    { id: 'visitors', label: tx(l, 'Besucher', 'Visitors'), value: vCur, ...changeText(l, vCur, vPrev) },
    { id: 'posted', label: tx(l, 'Veröffentlicht', 'Published'), value: pCur, ...changeText(l, pCur, pPrev, 'abs') },
  ]

  const all = await openTaskViews(c.db, c.s.workspace, scope(c, project))
  const rows = all.filter(r => forYouNow(r.view) && (!r.view.userId || r.view.userId === c.s.user.id))
  const claudeN = all.filter(r => r.view.who === 'claude' && r.task.forClaude && r.task.dueDate && r.task.dueDate <= d).length
  const agentN = all.filter(r => r.task.dueDate === d && !r.task.forClaude && whoOf(r.view) !== 'you' && (r.view.who === 'ai' || r.view.who === 'claude')).length
  const slugOf = new Map(projects.map(p => [p.id, p.slug]))
  const isOpenDraft = (r: typeof rows[number]) => r.view.who === 'you' && r.view.draft && OPEN_NEXT.includes(r.view.next)
  const drafts = rows.filter(isOpenDraft)
  const todos: AppTodo[] = []
  const draftTitle = (n: number) => n === 1 ? tx(l, '1 Entwurf freigeben', 'Approve 1 draft') : tx(l, `${n} Entwürfe freigeben`, `Approve ${n} drafts`)
  // Bei "Alle Projekte" eine Freigaben-Zeile je Projekt, damit man sieht, wo es wartet.
  const groups = project ? [{ slug: project.slug, list: drafts }] : projects.map(p => ({ slug: p.slug, list: drafts.filter(r => r.task.projectId === p.id) })).filter(g => g.list.length)
  for (const g of groups) {
    if (!g.list.length) continue
    const min = Math.max(1, g.list.reduce((n, r) => n + r.view.min, 0))
    // Ein einzelner Entwurf öffnet sich direkt, mehrere als Freigaben dieses Projekts.
    const one = g.list.length === 1 ? g.list[0]!.view.draftId : null
    todos.push({ id: project ? 'approvals' : `approvals:${g.slug}`, title: draftTitle(g.list.length), minutes: min, kind: 'approvals', projectId: g.slug, approvalId: one })
  }
  const rest = rows.filter(r => !isOpenDraft(r)).slice(0, project ? 4 : 8)
  const asks = await openQuestions(c, rest.filter(r => r.view.next === 'answer').map(r => r.task.id))
  for (const r of rest) {
    const ask = r.view.next === 'answer' ? asks.get(r.task.id) : undefined
    todos.push({ id: r.task.id, taskId: r.task.id, title: r.task.title, minutes: Math.max(1, r.view.min), kind: r.view.next === 'answer' ? 'question' : 'task', detail: safeDetail(l, ask ?? (r.task.humanStep || r.task.description?.slice(0, 400) || null)), projectId: r.task.projectId ? slugOf.get(r.task.projectId) ?? null : null, approvalId: r.view.draftId })
  }

  // Wie die Gruppen "Bald dran" und "Claude prüft" der App-Freigaben (nur offene Entwürfe, ohne Filter nach Person).
  const later = todos.length ? null : waitingLater(all.map(r => r.view), { openOnly: true })
  const traffic = await utmSummary(c.db, c.s.workspace.id, projects.map(p => p.id), addDays(d, -7), addDays(d, -1))
  const top = traffic.sources.filter(s => s.visits > 0).sort((a, b) => b.visits - a.visits)[0]
  const agentSentence = top
    ? tx(l, `Die meisten Besucher kamen diese Woche über ${sourceName(top.source)}.`, `Most visitors came via ${sourceName(top.source)} this week.`)
    : pCur
      ? tx(l, `Diese Woche ist ${pCur === 1 ? '1 Beitrag' : `${pCur} Beiträge`} rausgegangen.`, `${pCur} ${pCur === 1 ? 'post' : 'posts'} went out this week.`)
      : tx(l, 'Frag mich, wie es läuft oder was als Nächstes kommt.', 'Ask me how things are going or what comes next.')

  return { project: project ? appProject(project) : allProject(l), numbers, agentSentence, todos, idle: later ? waitingText(l, d, later) : null, aiToday: aiTodayText(l, claudeN, agentN), pendingApprovals: drafts.length, projects: project ? [] : await perProject(c, projects, 7, l) }
}

// Offene Entwürfe, die auf dich warten: freigeben, prüfen oder eine Rückfrage beantworten.
const OPEN_NEXT: string[] = ['approve', 'review', 'answer']

// Die echte Rückfrage des Agenten je Aufgabe (neueste "Info nötig"-Notiz, ohne Vorsatz).
async function openQuestions(c: AppCtx, taskIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!taskIds.length) return out
  const notes = await c.db.select({ taskId: schema.taskNotes.taskId, text: schema.taskNotes.text }).from(schema.taskNotes)
    .where(and(inArray(schema.taskNotes.taskId, taskIds), eq(schema.taskNotes.byAgent, true), sql`${schema.taskNotes.text} like 'Info nötig:%'`))
    .orderBy(desc(schema.taskNotes.createdAt))
  for (const n of notes) if (!out.has(n.taskId)) out.set(n.taskId, n.text.replace(/^Info nötig:\s*/, ''))
  return out
}

export function allProject(l: Lang): AppProject {
  return { id: ALL_SLUG, name: tx(l, 'Alle Projekte', 'All projects'), initials: '*', color: null }
}

// Aufschlüsselung je Projekt bei "Alle Projekte": Besucher im Zeitraum und Veränderung zum Zeitraum davor.
async function perProject(c: AppCtx, projects: Project[], span: number, l: Lang): Promise<AppProjectValue[]> {
  const out: AppProjectValue[] = []
  for (const p of projects) {
    const days = await visitorDays(c, [p], span * 2)
    const cur = sum(days.slice(span))
    const prev = sum(days.slice(0, span))
    const q = pct(cur, prev)
    out.push({ id: p.slug, name: p.name, color: p.color ?? null, visitors: cur, change: q === null ? '' : `${q > 0 ? '+' : ''}${pctText(l, q)}` })
  }
  return out.sort((a, b) => b.visitors - a.visitors)
}

const SOURCE_NAMES: Record<string, string> = { reddit: 'Reddit', x: 'X', twitter: 'X', linkedin: 'LinkedIn', mastodon: 'Mastodon', bluesky: 'Bluesky', instagram: 'Instagram', threads: 'Threads', facebook: 'Facebook', tiktok: 'TikTok', telegram: 'Telegram', youtube: 'YouTube', blog: 'Blog', newsletter: 'Newsletter', mail: 'Mail', google: 'Google' }
export function sourceName(s: string): string {
  return SOURCE_NAMES[s.toLowerCase()] ?? (s ? s[0]!.toUpperCase() + s.slice(1) : s)
}

function webUrl(project: Project | null | undefined, path: string): string {
  return `${config.publicUrl}/p/${project?.slug ?? 'alle'}${path}`
}

// Ein Entwurf für die App: Plattform, Ort, Text und bei Antworten der Originalbeitrag.
export async function toApproval(c: AppCtx, task: Task, draft: Draft, project: Project | null, opts: { where?: Awaited<ReturnType<typeof whereLookup>>, canApprove?: boolean } = {}): Promise<AppApproval> {
  const l = langOf(c)
  const where = (opts.where ?? await whereLookup(c.db, c.s.workspace, project ? [project] : undefined))({ ...task, draftKind: task.draftKind ?? draft.kind })
  const notes = await c.db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(20)
  const src = replySourceOf({ description: task.description, createdAt: task.createdAt, title: task.title, notes, notesSince: draft.createdAt })
  const platform = markOf({ ...task, draftKind: draft.kind }) ?? draft.platforms[0] ?? (draft.kind === 'article' ? 'blog' : null)
  const isReply = !!src && (src.relation !== 'link' || /^Antwort: /.test(task.title))
  const place = where.place ?? (src?.sub ? `r/${src.sub}` : null)
  const pName = platform ? sourceName(platform) : null
  const headline = draft.kind === 'mail'
    ? tx(l, 'Antwort per Mail', 'Mail reply')
    : draft.kind === 'article'
      ? tx(l, 'Blog-Artikel', 'Blog article')
      : isReply
        ? tx(l, `Antwort${pName ? ` auf ${pName}` : ''}`, `Reply${pName ? ` on ${pName}` : ''}`)
        : tx(l, `Beitrag${pName ? ` auf ${pName}` : ''}`, `Post${pName ? ` on ${pName}` : ''}`)
  const text = (platform && draft.variants[platform]) || draft.body
  const state = draft.status === 'offen' ? 'pending' : draft.status === 'freigegeben' ? 'approved' : 'rejected'
  const infoNeeded = state === 'pending' && notes.some(n => n.byAgent && n.text.startsWith('Info nötig:') && n.createdAt.getTime() >= draft.createdAt.getTime() - 2000)
  return {
    id: draft.id,
    taskId: task.id,
    projectId: project?.slug ?? null,
    platform,
    title: task.title,
    headline,
    place,
    text: draft.subject && draft.kind !== 'text' ? `${draft.subject}\n\n${text}` : text,
    original: src && isReply ? { place: src.sub ? `r/${src.sub}` : src.author ? `@${src.author.replace(/^@/, '')}` : place ?? '', title: src.title ?? '', text: src.text.slice(0, 1500), url: src.url, author: src.author ? src.author.replace(/^@/, '') : null, at: src.at, age: src.age } : null,
    state,
    canApprove: opts.canApprove ?? (state === 'pending' && draft.kind !== 'mail' && !infoNeeded),
    infoNeeded,
    due: task.dueDate,
    time: task.dueTime,
    webUrl: webUrl(project, `/freigaben/${draft.id}`),
    why: isReply ? replyWhy(task.description) : null,
    aiGenerated: draft.aiGenerated,
  }
}

// Begründung aus der Aufgabe: Zeile "Warum: ..." (Listening) oder das Problem der Person (Community-Suche).
export function replyWhy(desc: string | null | undefined): string | null {
  const d = desc ?? ''
  const m = /^Warum: (.+)$/m.exec(d) ?? new RegExp(`^${SWEEP_PROBLEM}\\s*(.+)$`, 'm').exec(d)
  const t = m?.[1]?.replace(/[\u2013\u2014]/g, '-').trim()
  if (!t) return null
  return t.length > 400 ? `${t.slice(0, 397).trimEnd()}...` : t
}

// Freigaben der App wie im Web: Zu tun (dieselbe Zahl wie Heute und Badge), Bald dran, Claude prüft, Geht automatisch raus, Erledigt (24 h). Mails werden nur im Web gesendet.
export async function appApprovals(c: AppCtx, project: Project | null): Promise<AppApproval[]> {
  const lists = await draftLists(c.db, c.s.workspace, scope(c, project))
  const mine = (r: { view: { userId: string | null } }) => !r.view.userId || r.view.userId === c.s.user.id
  const offen = (r: { draft: Draft }) => r.draft.status === 'offen'
  const rows = [
    ...lists.yours.filter(r => offen(r) && mine(r)).map(r => ({ ...r, group: 'yours' as const })),
    ...lists.soon.filter(offen).map(r => ({ ...r, group: 'soon' as const })),
    ...lists.claude.filter(offen).map(r => ({ ...r, group: 'claude' as const })),
  ]
  const outgoing = (await reviewerOutgoing(c, project)).map(a => ({ ...a, group: 'outgoing' as const }))
  const done = await doneApprovals(c, project)
  if (!rows.length) return [...outgoing, ...done]
  const projects = await scopeProjects(c, project)
  const byId = new Map(projects.map(p => [p.id, p]))
  const where = await whereLookup(c.db, c.s.workspace, projects)
  const infos = await c.db.select({ taskId: schema.taskNotes.taskId, at: schema.taskNotes.createdAt }).from(schema.taskNotes)
    .where(and(inArray(schema.taskNotes.taskId, rows.map(r => r.task.id)), eq(schema.taskNotes.byAgent, true), sql`${schema.taskNotes.text} like 'Info nötig:%'`))
  const out: { a: AppApproval, info: boolean }[] = []
  for (const r of rows) {
    const info = infos.some(n => n.taskId === r.task.id && n.at.getTime() >= r.draft.createdAt.getTime() - 2000)
    out.push({ a: { ...await toApproval(c, r.task, r.draft, r.task.projectId ? byId.get(r.task.projectId) ?? null : null, { where, canApprove: !info && r.draft.kind !== 'mail' }), claudeChecks: r.group === 'claude', group: r.group, infoNeeded: info }, info })
  }
  // Rückfragen (Info nötig) zuerst.
  return [...out.filter(x => x.info).map(x => x.a), ...out.filter(x => !x.info).map(x => x.a), ...outgoing, ...done]
}

// Erledigt: in den letzten 24 Stunden freigegeben.
async function doneApprovals(c: AppCtx, project: Project | null): Promise<AppApproval[]> {
  const list = await recentlyDone(c.db, c.s.workspace, scope(c, project), 1)
  if (!list.length) return []
  const projects = await scopeProjects(c, project)
  const byId = new Map(projects.map(p => [p.id, p]))
  const where = await whereLookup(c.db, c.s.workspace, projects)
  const out: AppApproval[] = []
  for (const r of list) out.push({ ...await toApproval(c, r.task, r.draft, r.task.projectId ? byId.get(r.task.projectId) ?? null : null, { where, canApprove: false }), group: 'done' })
  return out
}

// "Geht raus": vom KI-Prüfer freigegeben, noch nicht veröffentlicht. Gesammelt in der Liste, keine Einzel-Push.
async function reviewerOutgoing(c: AppCtx, project: Project | null): Promise<AppApproval[]> {
  const list = await reviewerReleases(c.db, c.s.workspace.id, { onlyStoppable: true, cond: scope(c, project) })
  const out: AppApproval[] = []
  for (const r of list) {
    const { task, draft, project: p } = await loadDraft(c, r.draftId)
    out.push({ ...await toApproval(c, task, draft, p, { canApprove: false }), byReviewer: true, releaseAt: r.releaseAt?.toISOString() ?? null })
  }
  return out
}

// Entwurf über die App laden (gleiche Sichtbarkeit wie im Web).
export async function loadDraft(c: AppCtx, draftId: string): Promise<{ task: Task, draft: Draft, project: Project | null }> {
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) throw new AppError(404, 'Entwurf nicht gefunden')
  const [row] = await c.db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, draftId), eq(schema.tasks.workspaceId, c.s.workspace.id)))
  if (!row) throw new AppError(404, 'Entwurf nicht gefunden')
  const project = row.task.projectId ? (await c.db.select().from(schema.projects).where(eq(schema.projects.id, row.task.projectId)))[0] ?? null : null
  if (!c.access.all && (!project || !c.access.ids.includes(project.id))) throw new AppError(404, 'Entwurf nicht gefunden')
  return { ...row, project }
}

export async function loadTask(c: AppCtx, taskId: string): Promise<Task> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new AppError(404, 'Aufgabe nicht gefunden')
  const [t] = await c.db.select().from(schema.tasks).where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, c.s.workspace.id)))
  if (!t || (!c.access.all && (!t.projectId || !c.access.ids.includes(t.projectId)))) throw new AppError(404, 'Aufgabe nicht gefunden')
  return t
}

// Plan: die nächsten 7 Tage ab heute (bzw. die Woche von day), je Tag.
export async function appPlan(c: AppCtx, project: Project | null, day?: string | null) {
  const l = langOf(c)
  const from = day ? startOfWeek(day) : today(c.s.workspace.timezone)
  const to = addDays(from, 6)
  const tasks = await c.db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, c.s.workspace.id), scope(c, project), ne(schema.tasks.status, 'verworfen'), gte(schema.tasks.dueDate, from), lte(schema.tasks.dueDate, to)))
    .orderBy(schema.tasks.dueDate, sql`${schema.tasks.dueTime} asc nulls first`).limit(120)
  const views = await taskViews(c.db, c.s.workspace, tasks)
  const slugOf = new Map((await scopeProjects(c, project)).map(p => [p.id, p.slug]))
  return tasks.map((t) => {
    const v = views.get(t.id)!
    const human = v.who === 'you' || v.then === 'post'
    const platform = markOf(t)
    const opens = v.who === 'you' && v.draft ? 'approvals' as const : v.next === 'answer' ? 'question' as const : null
    const who = whoOf(v)
    const detail = v.next === 'claude'
      ? tx(l, 'Website-Aufgabe: erledigt Claude über MCP, für dich ist nichts zu tun.', 'Website task: Claude handles it via MCP, nothing to do for you.')
      : v.draftId && v.next === 'answer'
      ? tx(l, 'Der Agent hat eine Rückfrage. Antworte im Entwurf, dann schreibt er neu.', 'The agent has a question. Answer in the draft, then it rewrites.')
      : v.draftId && v.bucket === 'yours'
      ? tx(l, 'Entwurf fertig, wartet auf deine Freigabe.', 'Draft ready, waiting for your approval.')
      : v.draftId && v.bucket === 'soon'
      ? tx(l, 'Entwurf fertig, du bist an seinem Tag dran.', 'Draft ready, your turn on its day.')
      : v.draftId && v.bucket === 'claude'
      ? tx(l, 'Entwurf fertig, Claude prüft ihn.', 'Draft ready, Claude is checking it.')
      : v.who === 'ai' && !v.draftId
      ? tx(l, 'Schreibt der Agent.', 'The agent writes this.')
      : v.bucket === 'outgoing'
        ? tx(l, 'Geht automatisch raus.', 'Goes out automatically.')
        : safeDetail(l, t.humanStep || t.description?.slice(0, 400) || null)
    return { id: t.id, day: t.dueDate!, title: t.title, kind: human && !platform ? 'todo' as const : 'post' as const, platform, time: t.dueTime, done: DONE_STATUSES.includes(t.status), who, opens, detail, projectId: t.projectId ? slugOf.get(t.projectId) ?? null : null, draftId: v.draftId && !DONE_STATUSES.includes(t.status) ? v.draftId : null }
  })
}

// Ergebnisse: Besucher der Woche bzw. der letzten 4 Wochen und woher sie kamen.
export async function appResults(c: AppCtx, project: Project | null, period: 'week' | 'month') {
  const l = langOf(c)
  const d = today(c.s.workspace.timezone)
  const projects = await scopeProjects(c, project)
  const span = period === 'week' ? 7 : 28
  const days = await visitorDays(c, projects, span * 2)
  const cur = sum(days.slice(span))
  const prev = sum(days.slice(0, span))
  const end = addDays(d, -1)
  const series = period === 'week'
    ? days.slice(span).map((value, i) => ({ label: DAY_SHORT[l][weekday(addDays(end, i - 6)) - 1]!, value }))
    : [0, 1, 2, 3].map((w) => {
        const first = addDays(end, -27 + w * 7)
        return { label: l === 'en' ? `${Number(first.slice(5, 7))}/${Number(first.slice(8, 10))}` : `${first.slice(8, 10)}.${first.slice(5, 7)}.`, value: sum(days.slice(span + w * 7, span + w * 7 + 7)) }
      })
  const traffic = await utmSummary(c.db, c.s.workspace.id, projects.map(p => p.id), addDays(d, -span), end)
  const sources = traffic.sources.filter(s => s.visits > 0).sort((a, b) => b.visits - a.visits).slice(0, 5).map(s => ({ name: sourceName(s.source), platform: s.source.toLowerCase(), visitors: s.visits }))
  const top = sources[0]
  const p = pct(cur, prev)
  return {
    period,
    visitors: cur,
    change: p === null ? '' : `${p > 0 ? '+' : ''}${pctText(l, p)}`,
    series,
    sources,
    projects: project ? [] : await perProject(c, projects, span, l),
    agentTip: top ? tx(l, `${top.name} bringt gerade die meisten Besucher. Frag mich, warum.`, `${top.name} brings the most visitors right now. Ask me why.`) : tx(l, 'Noch keine Besucher mit Herkunft gemessen.', 'No visitors with a source measured yet.'),
  }
}
