import { and, desc, eq, gt, inArray, isNull, like, sql } from 'drizzle-orm'
import { DONE_STATUSES, OPEN_STATUSES } from '../../shared/utils/domain'
import { accountDeclined, askAccountsText, isCommunitySweep, parseAccountAnswer, SWEEP_AGENT_STEP, SWEEP_ASK, SWEEP_HUMAN_STEP, SWEEP_MAX, SWEEP_NONE, SWEEP_ORIGIN, SWEEP_PROBLEM, sweepServices, type SweepService } from '../../shared/utils/community-sweep'
import { REDDIT_SETUP } from '../../shared/utils/reddit'
import { accountKnown } from '../../shared/utils/service'
import { TALK_PREFIX } from '../../shared/utils/talk'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import type { FetchLike } from './outlets'
import { braveKey, braveSearch, onSiteResults, redditThreadOf, siteQuery } from './platforms/brave'
import { keywords, NO_HELP_SKIP, redditLookup, threadFresh, threadSearch, type RedditLookup, type RedditThread } from './reddit'
import { activeStrategy, projectOwner } from './strategy'
import { createTask } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect

export interface SweepDeps {
  query: (pseudo: Task, project: Project, subs: string[]) => Promise<string[] | null>
  pick: (pseudo: Task, project: Project, threads: RedditThread[]) => Promise<RedditThread | null>
  taken: () => Promise<Set<string>>
  webFetch: FetchLike
  log: string[]
}

export interface SweepOutcome {
  status: 'ok' | 'skipped'
  summary: string
  created: string[]
}

const dash = (s: string) => s.replace(/[\u2013\u2014]/g, '-')
const FORUM_ITEM: Record<string, RegExp> = {
  hn: /news\.ycombinator\.com\/item\?id=\d+/i,
  indiehackers: /indiehackers\.com\/post\//i,
  producthunt: /producthunt\.com\/(discussions|posts)\//i,
}

function grabSubs(texts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of texts.join(' ').matchAll(/(?:^|[\s/(,;"'])r\/([A-Za-z0-9_]{2,21})\b/g)) {
    const k = m[1]!.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(m[1]!)
  }
  return out
}

// Orte eines Projekts: Analyse, Community-Kanäle der Strategie und Projekt-Gedächtnis.
async function placesOf(db: Db, project: Project, memory: string[]): Promise<string[]> {
  const st = await activeStrategy(db, project.id).catch(() => null)
  const channels = (st?.channels ?? []).filter(c => c.category === 'community' || /reddit|r\//i.test(`${c.name} ${(c.places ?? []).join(' ')}`))
  return grabSubs([...(project.setup?.analysis?.communities ?? []), ...channels.flatMap(c => [c.name, ...(c.places ?? [])]), ...memory])
}

function rotate<T>(list: T[], day: string, n: number): T[] {
  if (list.length <= n) return list
  const start = Number(day.replace(/-/g, '')) % list.length
  return [...list.slice(start), ...list.slice(0, start)].slice(0, n)
}

function pseudoTask(task: Task, project: Project, title: string, channel: string): Task {
  return { ...task, projectId: project.id, title, channel, description: [project.description, task.description].filter(Boolean).join('\n'), targetUrl: null }
}

// Gibt es schon Gepostetes auf Reddit? Dann ist das Konto da.
async function postedOnReddit(db: Db, workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, workspaceId),
    inArray(schema.tasks.status, DONE_STATUSES),
    sql`concat_ws(' ', ${schema.tasks.postedUrl}, ${schema.tasks.targetUrl}, ${schema.tasks.channel}) ~* 'reddit'`,
  )).limit(1)
  return !!row
}

async function rememberAll(db: Db, projects: Project[], text: string): Promise<void> {
  if (projects.length) await db.insert(schema.projectMemory).values(projects.map(p => ({ projectId: p.id, kind: 'fakt' as const, text })))
}

// Konto-Rückfrage: Antwort auswerten, sonst einmal fragen. Liefert die Dienste mit bekanntem Konto.
async function accountsFor(db: Db, ws: Workspace, task: Task, projects: Project[], memory: string[], deps: SweepDeps): Promise<{ active: SweepService[], asked: boolean }> {
  const services = sweepServices(task)
  const texts = [...memory, ...projects.flatMap(p => p.setup?.facts?.known ?? [])]
  const reddit = await postedOnReddit(db, ws.id)
  const known = (s: SweepService) => accountKnown(s.name, texts) || (s.key === 'reddit' && reddit)
  const [ask] = await db.select().from(schema.drafts).where(and(eq(schema.drafts.taskId, task.id), eq(schema.drafts.status, 'offen'), like(schema.drafts.body, `${SWEEP_ASK}%`))).orderBy(desc(schema.drafts.version)).limit(1)
  let open = services.filter(s => !known(s) && !accountDeclined(s.name, texts))
  if (ask && open.length) {
    const answers = (await db.select().from(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, task.id), eq(schema.taskNotes.byAgent, false), gt(schema.taskNotes.createdAt, ask.createdAt))).orderBy(schema.taskNotes.createdAt))
      .map(n => n.text.replace(new RegExp(`^${TALK_PREFIX.user}\\s*`), '').trim()).filter(Boolean)
    const target = task.projectId ? projects.filter(p => p.id === task.projectId) : projects
    for (const text of answers) {
      const r = parseAccountAnswer(text, open.map(s => s.name))
      for (const s of open) {
        if (!r[s.name]) continue
        const line = r[s.name] === 'yes' ? `Konto bei ${s.name} vorhanden (laut Antwort zu ${task.code})` : `Kein Konto bei ${s.name} (laut Antwort zu ${task.code}), dort sucht der Agent nicht`
        await rememberAll(db, target, line)
        texts.push(line)
        deps.log.push(`Konto ${s.name}: ${r[s.name]}`)
      }
      open = open.filter(s => !known(s) && !accountDeclined(s.name, texts))
    }
  }
  if (ask && !open.length) {
    await db.update(schema.drafts).set({ status: 'ersetzt' }).where(eq(schema.drafts.id, ask.id))
    await db.update(schema.tasks).set({ status: 'geplant', updatedAt: now() }).where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'entwurf_fertig')))
  }
  if (!ask && open.length) {
    const q = askAccountsText(open.map(s => s.name))
    const [last] = await db.select({ version: schema.drafts.version }).from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version)).limit(1)
    await db.insert(schema.drafts).values({ taskId: task.id, version: (last?.version ?? 0) + 1, platforms: [], variants: {}, media: [], kind: 'text', body: `${SWEEP_ASK} ${q}`, byAgent: true, aiGenerated: true, createdAt: now() })
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Info nötig: ${q}`, createdAt: new Date(now().getTime() + 1) })
    await db.update(schema.tasks).set({ status: 'entwurf_fertig', updatedAt: now() }).where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'geplant')))
  }
  return { active: services.filter(known), asked: open.length > 0 }
}

function forumThread(r: { title: string, url: string, snippet: string, age: string | null }, name: string): RedditThread {
  return { id: r.url, sub: name, title: r.title, url: r.url, author: '', createdAt: '', comments: 0, score: 0, locked: false, archived: false, text: r.snippet, via: 'brave', age: r.age }
}

async function answeredUrls(db: Db, workspaceId: string, parentId: string): Promise<Set<string>> {
  const rows = await db.select({ url: schema.tasks.targetUrl }).from(schema.tasks).where(and(eq(schema.tasks.workspaceId, workspaceId), like(schema.tasks.origin, `${SWEEP_ORIGIN}${parentId}%`)))
  return new Set(rows.flatMap(r => (r.url ? [r.url, redditThreadOf(r.url)?.id ?? r.url] : [])))
}

// Allgemeine Community-Aufgabe: Agent sucht selbst und legt je Thread eine Antwort-Aufgabe an, deren Entwurf in die Freigaben geht.
export async function runSweep(db: Db, ws: Workspace, task: Task, deps: SweepDeps): Promise<SweepOutcome> {
  const d = today(ws.timezone)
  if (!task.dueDate || task.dueDate < d) await db.update(schema.tasks).set({ dueDate: d, updatedAt: now() }).where(eq(schema.tasks.id, task.id))
  const projects = task.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId))
    : await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))
  if (!projects.length) return { status: 'skipped', summary: 'Kein Projekt für die Thread-Suche', created: [] }
  const memoryOf = new Map<string, string[]>()
  for (const p of projects) memoryOf.set(p.id, (await db.select({ text: schema.projectMemory.text }).from(schema.projectMemory).where(eq(schema.projectMemory.projectId, p.id))).map(m => m.text))
  const { active, asked } = await accountsFor(db, ws, task, projects, [...memoryOf.values()].flat(), deps)
  const open = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(like(schema.tasks.origin, `${SWEEP_ORIGIN}${task.id}%`), inArray(schema.tasks.status, OPEN_STATUSES)))
  const budget = SWEEP_MAX - open.length
  if (budget <= 0) return { status: 'skipped', summary: `Noch ${open.length} Antworten offen, keine neue Suche`, created: [] }
  if (!active.length) return { status: 'skipped', summary: asked ? 'Rückfrage zu den Konten gestellt' : 'Kein Konto für die Thread-Suche bekannt', created: [] }
  const usesReddit = active.some(s => s.key === 'reddit')
  if (usesReddit && !threadSearch(ws)) {
    const [had] = await db.select({ id: schema.taskNotes.id }).from(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, task.id), like(schema.taskNotes.text, `${REDDIT_SETUP}%`))).limit(1)
    if (!had) await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `${REDDIT_SETUP} Unter Einstellungen > Plattform-Zugänge einen Brave-Search-API-Schlüssel eintragen, dann sucht der Agent die Threads selbst.`, createdAt: now() })
  }
  const taken = await deps.taken()
  const done = await answeredUrls(db, ws.id, task.id)
  const at = now().getTime()
  const isFree = (t: RedditThread) => threadFresh(t, at) && !taken.has(redditThreadOf(t.url)?.id ?? t.url) && !done.has(t.url) && !done.has(redditThreadOf(t.url)?.id ?? t.url)
  const owner = task.assigneeUserId ?? (task.projectId ? await projectOwner(db, task.projectId) : null)
  const created: string[] = []
  const key = braveKey(ws)
  for (const project of rotate(projects, d, projects.length)) {
    if (created.length >= budget) break
    const memory = memoryOf.get(project.id) ?? []
    for (const svc of active) {
      if (created.length >= budget) break
      let pick: RedditThread | null = null
      let channel = svc.name
      try {
        if (svc.key === 'reddit') {
          if (!threadSearch(ws)) continue
          const subs = rotate(await placesOf(db, project, memory), d, 3)
          if (!subs.length) continue
          const pseudo = pseudoTask(task, project, `Antwort in ${subs.map(s => `r/${s}`).join(', ')}`, subs.map(s => `Reddit r/${s}`).join(' '))
          const words = await deps.query(pseudo, project, subs) ?? keywords(project.description ?? project.name)
          const r: RedditLookup | null = await redditLookup(ws, pseudo, [], deps.webFetch, deps.log, Date.now(), words, 'community')
          const free = r?.status === 'found' ? r.threads.filter(isFree) : []
          pick = free.length ? await deps.pick(pseudo, project, free) : null
          if (pick) channel = `Reddit r/${pick.sub}`
        }
        else if (svc.host && key) {
          const pseudo = pseudoTask(task, project, `Antwort auf ${svc.name}`, svc.name)
          const words = await deps.query(pseudo, project, []) ?? keywords(project.description ?? project.name)
          const found = onSiteResults(await braveSearch(key, siteQuery(svc.host, words), deps.webFetch, { freshness: 'pw', use: { ws: ws.id, project: project.id, purpose: 'community' } }), svc.host)
            .filter(x => FORUM_ITEM[svc.key]?.test(x.url) ?? true).slice(0, 6).map(x => forumThread(x, svc.name)).filter(isFree)
          pick = found.length ? await deps.pick(pseudo, project, found) : null
        }
      }
      catch (err) {
        deps.log.push(`Thread-Suche ${svc.name} (${project.name}) fehlgeschlagen: ${(err as Error).message.slice(0, 200)}`)
        continue
      }
      if (!pick) continue
      if (!pick.problem?.trim()) {
        deps.log.push(`${pick.url}: kein konkretes Problem benannt, keine Aufgabe`)
        continue
      }
      const where = svc.key === 'reddit' ? `r/${pick.sub}` : svc.name
      const child = await createTask(db, {
        workspaceId: ws.id,
        projectId: project.id,
        campaignId: task.campaignId,
        title: dash(`Antwort: ${pick.title}`).slice(0, 200),
        description: dash([`Link: ${pick.url}`, `Gefunden in ${where} für ${task.code} (${task.title}).`, `${SWEEP_PROBLEM} ${pick.problem.trim()}`, 'Inhalt (Auszug):', pick.text || pick.title].join('\n')).slice(0, 4000),
        category: 'community',
        channel,
        language: task.language,
        dueDate: d,
        agentStep: 'Antwort auf den Thread entwerfen',
        humanStep: SWEEP_HUMAN_STEP,
        estimateMin: 3,
        assigneeUserId: owner ?? await projectOwner(db, project.id),
        draftKind: 'post',
        targetUrl: pick.url,
        origin: `${SWEEP_ORIGIN}${task.id}`,
      })
      done.add(pick.url)
      created.push(child.code)
      await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: child.id }, dedupeKey: `draft_task:${child.id}:${d}` })
      await logActivity(db, { workspaceId: ws.id, projectId: project.id, taskId: child.id, actor: 'agent', action: 'task_created', detail: { title: child.title }, at: now() })
    }
  }
  if (!created.length) {
    await db.delete(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, task.id), like(schema.taskNotes.text, `${SWEEP_NONE}%`)))
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `${SWEEP_NONE} Der Agent sucht morgen wieder, für dich ist nichts zu tun.`, createdAt: now() })
    return { status: 'skipped', summary: 'Heute kein passender Thread gefunden', created }
  }
  await db.delete(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, task.id), like(schema.taskNotes.text, `${SWEEP_NONE}%`)))
  await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Passende Threads gefunden, Antworten kommen in die Freigaben: ${created.join(', ')}`, createdAt: now() })
  return { status: 'ok', summary: `${created.length} Antwort-Aufgaben aus der Thread-Suche angelegt: ${created.join(', ')}`, created }
}

// Thread, auf den eine Antwort-Aufgabe aus der Suche antwortet (Titel, Link, Auszug aus der Beschreibung).
export function sweepThread(task: Pick<Task, 'origin' | 'title' | 'targetUrl' | 'description'>): RedditThread | null {
  if (!task.origin?.startsWith(SWEEP_ORIGIN) || !task.targetUrl) return null
  const excerpt = /Inhalt \(Auszug\):\n([\s\S]*)$/.exec(task.description ?? '')?.[1]?.trim() ?? ''
  const problem = new RegExp(`^${SWEEP_PROBLEM}\\s*(.+)$`, 'm').exec(task.description ?? '')?.[1]?.trim()
  const r = redditThreadOf(task.targetUrl)
  const title = task.title.replace(/^Antwort:\s*/, '')
  return { id: r?.id ?? task.targetUrl, sub: r?.sub ?? '', title, url: task.targetUrl, author: '', createdAt: '', comments: 0, score: 0, locked: false, archived: false, text: excerpt, via: 'brave', age: null, ...(problem ? { problem } : {}) }
}

export function sweepForumSource(t: RedditThread, place: string): string {
  return [
    `Beitrag auf ${place} (über die Brave-Suche gefunden; nur Titel und Auszug bekannt):`,
    `"${t.title}"`,
    `Link: ${t.url}`,
    t.text ? `Auszug: ${t.text}` : '',
    t.problem ? `Problem der Person (laut Relevanz-Check): ${t.problem}` : '',
    '',
    'Schreibe die Antwort genau auf diesen Beitrag (nichts dazuerfinden), in der Sprache des Beitrags, und setze "targetUrl" exakt auf seinen Link.',
    NO_HELP_SKIP,
  ].filter(Boolean).join('\n')
}

// Offene Community-Sammelaufgaben einmal am Tag anstoßen.
export async function queueSweeps(db: Db, ws: Workspace, d: string, isSweep: (t: Task) => boolean): Promise<number> {
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    eq(schema.tasks.category, 'community'),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig']),
    sql`(${schema.tasks.dueDate} is null or ${schema.tasks.dueDate} <= ${d})`,
  ))
  const due = rows.filter(isSweep)
  for (const t of due) await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: t.id }, dedupeKey: `draft_task:${t.id}:${d}` })
  return due.length
}

// Einmalig beim Deploy: offene Sammelaufgaben (z.B. "Karma aufbauen") auf den Agenten umstellen und die Suche anstoßen.
export async function prepareSweeps(db: Db, ws: Workspace, d: string): Promise<string[]> {
  const rows = await db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, ws.id), eq(schema.tasks.category, 'community'), inArray(schema.tasks.status, ['geplant', 'entwurf_fertig'])))
  const out: string[] = []
  for (const t of rows.filter(isCommunitySweep)) {
    if (t.agentStep !== SWEEP_AGENT_STEP || t.humanStep !== SWEEP_HUMAN_STEP) {
      await db.update(schema.tasks).set({ agentStep: SWEEP_AGENT_STEP, humanStep: SWEEP_HUMAN_STEP, estimateMin: null, updatedAt: now() }).where(eq(schema.tasks.id, t.id))
      out.push(t.code)
    }
    await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: t.id }, dedupeKey: `draft_task:${t.id}:${d}` })
  }
  return out
}
