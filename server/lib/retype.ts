import { and, desc, eq, inArray, like, sql } from 'drizzle-orm'
import { addDays } from '../../shared/utils/dates'
import { DONE_STATUSES, OPEN_STATUSES, type Category } from '../../shared/utils/domain'
import { CATEGORY_DRAFT, CATEGORY_STEPS } from '../../shared/utils/plan'
import { isHttpUrl } from '../../shared/utils/url'
import { isOwnBlog, isOwnSite } from '../../shared/utils/where'
import { cancelPosts } from './publish'
import { now, today } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import { activeStrategy } from './strategy'
import { createTask, updateTask, type TaskPatch, type TaskRow } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export const WAITS_FOR_ARTICLE = 'Wartet auf Artikel:'
export const RETYPE_TARGETS = ['content', 'social', 'community', 'verzeichnis', 'launch', 'pflege'] as const satisfies readonly Category[]

const KIND_LABEL: Record<string, string> = { post: 'Social-Post', article: 'Blog-Artikel', text: 'Text', mail: 'Mail' }

export function isArticle(t: Pick<TaskRow, 'category' | 'draftKind'>): boolean {
  return t.category === 'content' || t.draftKind === 'article'
}

export class RetypeError extends Error {}

const SOCIAL_HEAD = /^(antwort|reply|post|social-?posts?)\s*:\s*/i
const ARTICLE_HEAD = /^(blog-?artikel|artikel( ausbauen| überarbeiten)?)\s*:\s*/i

// Titel passend zur neuen Art: aus "Antwort: X" wird ein Artikel ("Artikel überarbeiten: X" bei einer bestehenden eigenen Seite), aus "Artikel: X" ein "Post: X".
export function retypeTitle(title: string, category: string, ownPage: boolean): string {
  if (category === 'content') {
    if (!SOCIAL_HEAD.test(title)) return title
    return `${ownPage ? 'Artikel überarbeiten' : 'Artikel'}: ${title.replace(SOCIAL_HEAD, '')}`.slice(0, 200)
  }
  if (category === 'social' && ARTICLE_HEAD.test(title)) return `Post: ${title.replace(ARTICLE_HEAD, '')}`.slice(0, 200)
  return title
}

async function projectOf(db: DbOrTx, id: string | null): Promise<Project | null> {
  return id ? (await db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0] ?? null : null
}

// Kanal des eigenen Blogs aus der Strategie, sonst "Blog".
async function blogChannel(db: DbOrTx, projectId: string | null): Promise<{ channel: string, key: string | null }> {
  const st = projectId ? await activeStrategy(db, projectId) : null
  const ch = st?.channels.find(c => c.category === 'content' && c.active && (isOwnBlog(c.name) || (c.places ?? []).some(p => isOwnBlog(p))))
  return { channel: 'Blog', key: ch?.key ?? null }
}

async function socialChannel(db: DbOrTx, projectId: string | null): Promise<{ channel: string, key: string } | null> {
  const st = projectId ? await activeStrategy(db, projectId) : null
  const ch = st?.channels.find(c => c.category === 'social' && c.active) ?? st?.channels.find(c => c.category === 'social')
  return ch ? { channel: ch.name, key: ch.key } : null
}

function ownUrl(url: string | null | undefined, project: Project | null): string | null {
  if (!url || !isHttpUrl(url) || !project) return null
  return isOwnSite(url, project.setup?.blog ?? null) || isOwnSite(url, project.url) ? url : null
}

export interface RetypeResult {
  task: TaskRow
  from: { category: string, draftKind: string | null }
  keptDraft: boolean
  redraft: boolean
}

// Kategorie und Entwurfsart umstellen (z.B. Social-Post -> Blog-Artikel). Code, Verlauf, Notizen und Links bleiben.
export async function retypeTask(db: DbOrTx, ws: Workspace, task: TaskRow, category: Category, actor: { type: 'user' | 'agent', userId?: string | null }, opts: { redraft?: boolean, enqueue?: boolean } = {}): Promise<RetypeResult> {
  if (!OPEN_STATUSES.includes(task.status)) throw new RetypeError(`Aufgabe ${task.code} ist ${task.status}, umstellen geht nur bei offenen Aufgaben`)
  if (!(RETYPE_TARGETS as readonly string[]).includes(category)) throw new RetypeError(`Umstellen auf ${category} geht nicht (Mails nur über eigene Aufgaben)`)
  const kind = CATEGORY_DRAFT[category] ?? null
  const from = { category: task.category, draftKind: task.draftKind }
  if (category === task.category && kind === task.draftKind) return { task, from, keptDraft: true, redraft: false }
  const project = await projectOf(db, task.projectId)
  const steps = CATEGORY_STEPS[category]
  const patch: TaskPatch = {
    category,
    draftKind: kind,
    agentStep: kind ? steps?.agent ?? 'Entwurf' : null,
    humanStep: steps?.human ?? task.humanStep ?? 'Erledigen',
    estimateMin: steps?.estimate ?? task.estimateMin,
  }
  if (category === 'content') {
    const blog = await blogChannel(db, task.projectId)
    patch.channel = blog.channel
    patch.strategyChannel = blog.key
    patch.targetUrl = ownUrl(task.targetUrl, project)
  }
  else if (category === 'social') {
    const soc = await socialChannel(db, task.projectId)
    patch.channel = soc?.channel ?? null
    patch.strategyChannel = soc?.key ?? null
    patch.targetUrl = ownUrl(task.targetUrl, project) ?? (isOwnBlog(task.channel) ? null : task.targetUrl)
  }
  else patch.strategyChannel = null
  const title = retypeTitle(task.title, category, category === 'content' && !!patch.targetUrl)
  if (title !== task.title) patch.title = title
  const [last] = await db.select().from(schema.drafts).where(and(eq(schema.drafts.taskId, task.id), inArray(schema.drafts.status, ['offen', 'freigegeben']))).orderBy(desc(schema.drafts.version)).limit(1)
  const keep = !!last && kind === 'article' && !opts.redraft
  await cancelPosts(db, task.id)
  if (last) {
    await db.update(schema.drafts).set({ status: 'ersetzt' }).where(and(eq(schema.drafts.taskId, task.id), inArray(schema.drafts.status, ['offen', 'freigegeben'])))
    if (keep) {
      const [top] = await db.select({ version: schema.drafts.version }).from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version)).limit(1)
      await db.insert(schema.drafts).values({ taskId: task.id, version: (top?.version ?? last.version) + 1, kind: 'article', subject: last.subject ?? task.title, body: last.body, targetUrl: ownUrl(last.targetUrl, project), platforms: [], variants: {}, media: last.media ?? [], status: 'offen', byAgent: true, aiGenerated: last.aiGenerated, createdAt: now() })
      patch.status = 'entwurf_fertig'
    }
    else patch.status = 'geplant'
  }
  else if (task.status === 'entwurf_fertig' || task.status === 'freigegeben') patch.status = 'geplant'
  const row = await updateTask(db, task, patch, actor)
  const label = (k: string | null) => KIND_LABEL[k ?? ''] ?? 'ohne Entwurf'
  await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Umgestellt: ${label(from.draftKind)} -> ${label(kind)} (vorher ${from.category}, jetzt ${category}). Code, Verlauf und Links bleiben.${keep ? ' Der bisherige Text ist jetzt der Artikel-Entwurf, ohne Plattform-Fassungen.' : ''}`, createdAt: now() })
  const redraft = !!kind && !keep
  if (redraft && opts.enqueue !== false) await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: task.id }, dedupeKey: `draft_task:${task.id}:${now().getTime()}` })
  return { task: row, from, keptDraft: keep, redraft }
}

// Social-Posts als eigene Aufgabe, die auf einen Artikel verweist; geschrieben wird erst nach der Veröffentlichung.
export async function createLinkedPosts(db: DbOrTx, ws: Workspace, article: TaskRow, opts: { userId?: string | null, origin?: string | null, wish?: string | null, channel?: { channel: string | null, key: string | null } | null } = {}): Promise<{ task: TaskRow, created: boolean }> {
  const [had] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.dependsOnId, article.id), eq(schema.tasks.category, 'social'))).limit(1)
  if (had) return { task: had, created: false }
  const d = today(ws.timezone)
  const base = article.dueDate && article.dueDate > d ? article.dueDate : d
  const ch = opts.channel?.key ? opts.channel : await socialChannel(db, article.projectId)
  const steps = CATEGORY_STEPS.social!
  const short = article.title.replace(ARTICLE_HEAD, '').replace(SOCIAL_HEAD, '')
  const task = await createTask(db, {
    workspaceId: ws.id,
    projectId: article.projectId,
    title: `Social-Posts zum Artikel: ${short}`.slice(0, 200),
    description: [
      `Verweist auf den Blog-Artikel ${article.code} ("${article.title}"). Ziel: Leser auf den Artikel bringen, Link zum Artikel gehört in den Post.`,
      'Wird erst geschrieben, wenn der Artikel veröffentlicht ist; der Link kommt dann automatisch dazu.',
      opts.wish ? `Wunsch: ${opts.wish}` : '',
    ].filter(Boolean).join('\n'),
    category: 'social',
    channel: ch?.channel ?? null,
    strategyChannel: ch?.key ?? null,
    dueDate: addDays(base, 1),
    agentStep: steps.agent,
    humanStep: steps.human,
    estimateMin: steps.estimate,
    draftKind: 'post',
    dependsOnId: article.id,
    language: article.language,
    assigneeUserId: article.assigneeUserId,
    createdByUserId: opts.userId ?? null,
    origin: opts.origin ?? null,
    releaseOk: article.releaseOk,
  })
  await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `${WAITS_FOR_ARTICLE} ${article.code}. Der Post wird geschrieben, sobald der Artikel veröffentlicht ist.`, createdAt: now() })
  return { task, created: true }
}

export interface ArticleGate {
  wait: boolean
  code: string
  url: string | null
  dropped: boolean
}

// Verweist ein Social-Post auf einen Artikel: warten, bis er veröffentlicht ist, dann dessen Link nehmen.
export async function articleGate(db: DbOrTx, task: Pick<TaskRow, 'dependsOnId' | 'category' | 'draftKind'>): Promise<ArticleGate | null> {
  if (!task.dependsOnId || task.category !== 'social') return null
  const [a] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.dependsOnId))
  if (!a || !isArticle(a)) return null
  const done = DONE_STATUSES.includes(a.status)
  const url = done ? [a.postedUrl, a.targetUrl].find(u => isHttpUrl(u)) ?? null : null
  return { wait: !done, code: a.code, url, dropped: a.status === 'verworfen' }
}

export async function noteWaiting(db: DbOrTx, taskId: string, gate: ArticleGate): Promise<void> {
  const [had] = await db.select({ id: schema.taskNotes.id }).from(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, taskId), like(schema.taskNotes.text, `${WAITS_FOR_ARTICLE}%`))).limit(1)
  if (had) return
  await db.insert(schema.taskNotes).values({ taskId, byAgent: true, text: `${WAITS_FOR_ARTICLE} ${gate.code}${gate.dropped ? ' wurde verworfen. Diese Posts verwerfen oder auf etwas anderes umschreiben.' : '. Der Post wird geschrieben, sobald der Artikel veröffentlicht ist.'}`, createdAt: now() })
}

// Artikel ist veröffentlicht: verweisende Posts bekommen den Link, rücken auf frühestens heute und werden geschrieben.
export async function releaseLinkedPosts(db: DbOrTx, article: TaskRow): Promise<number> {
  if (!isArticle(article) || !DONE_STATUSES.includes(article.status)) return 0
  const rows = await db.select().from(schema.tasks).where(and(eq(schema.tasks.dependsOnId, article.id), eq(schema.tasks.category, 'social'), eq(schema.tasks.status, 'geplant')))
  if (!rows.length) return 0
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, article.workspaceId))
  if (!ws) return 0
  const d = today(ws.timezone)
  const url = [article.postedUrl, article.targetUrl].find(u => isHttpUrl(u)) ?? null
  for (const t of rows) {
    const patch: TaskPatch = {}
    if (url && t.targetUrl !== url) patch.targetUrl = url
    if (!t.dueDate || t.dueDate < d) patch.dueDate = d
    const r = Object.keys(patch).length ? await updateTask(db, t, patch, { type: 'agent' }) : t
    await db.delete(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, t.id), like(schema.taskNotes.text, `${WAITS_FOR_ARTICLE}%`)))
    if (r.dueDate && r.dueDate <= addDays(d, 2)) await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: t.id }, dedupeKey: `draft_task:${t.id}:${d}` })
  }
  return rows.length
}

// Gleiche Seite ohne Protokoll, www, Abfrage und Schrägstrich am Ende.
export function samePage(u: string): string {
  return u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
}

// Offene Aufgabe zum selben Ziel (gleiche Seite), damit ein neuer Wunsch eine neue Fassung wird statt einer neuen Aufgabe.
export async function openTaskForUrl(db: DbOrTx, projectId: string, url: string, kind: 'article' | 'post' | 'reply'): Promise<TaskRow | null> {
  const key = samePage(url)
  const rows = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']), sql`${schema.tasks.targetUrl} is not null`)).orderBy(desc(schema.tasks.updatedAt)).limit(200)
  const hits = rows.filter(t => samePage(t.targetUrl!) === key)
  if (kind === 'article') return hits.find(isArticle) ?? hits.find(t => t.category === 'social' && !t.dependsOnId) ?? null
  if (kind === 'post') return hits.find(t => t.category === 'social' && !t.dependsOnId) ?? null
  return hits.find(t => t.category === 'community' || t.category === 'social') ?? null
}

// Aufgaben-Chat: "Mach daraus einen Blogartikel" stellt um; ein Artikel bekommt verweisende Social-Posts.
export async function retypeFromTalk(db: DbOrTx, ws: Workspace, task: TaskRow, convert: 'article' | 'post' | null, posts: boolean, userId: string | null, revising: boolean): Promise<{ retyped: boolean, posts: string | null }> {
  let cur = task
  let retyped = false
  const was = { channel: task.channel, key: task.strategyChannel, category: task.category }
  const want = convert === 'article' ? 'content' : convert === 'post' ? 'social' : null
  if (want && want !== task.category && OPEN_STATUSES.includes(task.status)) {
    const r = await retypeTask(db, ws, task, want, { type: 'user', userId }, { redraft: revising, enqueue: !revising })
    cur = r.task
    retyped = true
  }
  if (!isArticle(cur) || !(retyped || posts)) return { retyped, posts: null }
  const l = await createLinkedPosts(db, ws, cur, { userId, channel: was.category === 'social' && was.key ? { channel: was.channel, key: was.key } : null })
  return { retyped, posts: l.task.code }
}
