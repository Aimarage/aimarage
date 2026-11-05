import { and, eq, inArray, sql } from 'drizzle-orm'
import { articleVersions } from '../../shared/utils/article'
import { internalTextProblems } from '../../shared/utils/outbound-guard'
import type { ProjectBlogApi } from '../db/schema'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import { keyHint, redactKey } from './llm'
import { decryptSecret, encryptSecret } from './secret'
import { addTaskLinks } from './task-links'
import { updateTask } from './tasks'
import { BLOG_TYPES, BlogApiError, BlogLangError, BlogRetryError, blogAdapter, publishTo, type ArticleImage, type FetchLike } from './blog'
import { gitRepoUrl, normalizeGit, type GitInput } from './blog/git'
import { fetchSite } from './site'
import { fetchImage, readMedia, sniff } from './media'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type Draft = typeof schema.drafts.$inferSelect
export { BlogApiError }
export type BlogType = typeof BLOG_TYPES[number]

export const LATE_HOURS = 24

function ctxOf(workspaceId: string, projectId: string, b: Pick<ProjectBlogApi, 'url' | 'type'>): string {
  return !b.type || b.type === 'aimarage' ? `blog-api|${workspaceId}|${projectId}|${b.url}` : `blog-api|${workspaceId}|${projectId}|${b.type}|${b.url}`
}

export function normalizeApiUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  }
  catch {
    throw new BlogApiError('Ungültige Adresse')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new BlogApiError('Nur http(s)-Adressen')
  u.hash = ''
  u.username = ''
  u.password = ''
  return u.toString()
}

export interface BlogApiInput {
  type?: BlogType
  url?: string | null
  token?: string | null
  user?: string | null
  status?: 'publish' | 'draft' | null
  category?: number | null
  collectionId?: string | null
  fields?: { title?: string | null, slug?: string | null, body?: string | null, description?: string | null } | null
  git?: GitInput | null
}

export function buildBlogApi(workspaceId: string, projectId: string, cur: ProjectBlogApi | null | undefined, input: BlogApiInput, at = new Date()): ProjectBlogApi {
  const type = input.type ?? 'aimarage'
  const git = type === 'git' ? normalizeGit(input.git) : null
  const url = git ? gitRepoUrl(git) : normalizeApiUrl(input.url ?? '')
  const user = type === 'wordpress' ? input.user?.trim() || null : null
  if (type === 'wordpress' && !user) throw new BlogApiError('Benutzername fehlt')
  const collectionId = type === 'webflow' ? input.collectionId?.trim() || null : null
  if (type === 'webflow' && !collectionId) throw new BlogApiError('Collection-ID fehlt')
  const same = !!cur && cur.url === url && (cur.type ?? 'aimarage') === type && (cur.user ?? null) === user && (cur.collectionId ?? null) === collectionId
  const token = input.token?.trim()
  const secret = token
    ? { enc: encryptSecret(token, ctxOf(workspaceId, projectId, { url, type })), hint: keyHint(token), setAt: at.toISOString() }
    : same ? cur?.secret ?? null : null
  const f = input.fields
  return {
    type,
    url,
    user,
    status: type === 'aimarage' ? undefined : input.status === 'draft' ? 'draft' : 'publish',
    category: type === 'wordpress' && input.category ? input.category : null,
    collectionId,
    fields: type === 'webflow' ? { title: f?.title?.trim() || 'name', slug: f?.slug?.trim() || 'slug', body: f?.body?.trim() || 'post-body', description: f?.description?.trim() || null } : null,
    git,
    secret,
    checkedAt: same && !token ? cur?.checkedAt ?? null : null,
    error: same && !token ? cur?.error ?? null : null,
    lastPublish: same ? cur?.lastPublish ?? null : null,
    skipLangs: same ? cur?.skipLangs ?? null : null,
  }
}

export function blogApiToken(workspaceId: string, projectId: string, b: ProjectBlogApi | null | undefined): string | null {
  if (!b?.secret) return null
  return decryptSecret(b.secret.enc, ctxOf(workspaceId, projectId, b))
}

export function publicBlogApi(b: ProjectBlogApi | null | undefined) {
  if (!b) return null
  return { type: b.type ?? 'aimarage', url: b.url, user: b.user ?? null, status: b.status ?? 'publish', category: b.category ?? null, collectionId: b.collectionId ?? null, fields: b.fields ?? null, git: b.git ?? null, hasToken: !!b.secret, hint: b.secret?.hint ?? '', checkedAt: b.checkedAt ?? null, error: b.error ?? null, lastPublish: b.lastPublish ?? null, skipLangs: b.skipLangs ?? [] }
}

export function blogHost(b: Pick<ProjectBlogApi, 'url' | 'git'> | null | undefined): string | null {
  const raw = b?.git?.publicUrl?.replace(/\{(slug|date|lang)\}/g, 'x') ?? b?.url
  if (!raw) return null
  try {
    return new URL(raw).host
  }
  catch {
    return null
  }
}

export function blogApiReady(project: Pick<Project, 'setup'> | null | undefined): boolean {
  return !!project?.setup?.blogApi?.secret
}

export function isArticleTask(task: Pick<Task, 'category' | 'draftKind' | 'channel'>, draft?: Pick<Draft, 'kind'> | null): boolean {
  if (draft && draft.kind !== 'article') return false
  return task.category === 'content' || task.draftKind === 'article'
}

async function setBlogApi(db: DbOrTx, projectId: string, patch: Partial<ProjectBlogApi>): Promise<void> {
  const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, projectId))
  if (!p?.setup?.blogApi) return
  await db.update(schema.projects).set({ setup: { ...p.setup, blogApi: { ...p.setup.blogApi, ...patch } } }).where(eq(schema.projects.id, projectId))
}

export async function checkBlogApi(db: Db, ws: Workspace, project: Project, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean, error: string | null }> {
  const b = project.setup?.blogApi
  if (!b) throw new BlogApiError('Keine Adresse eingetragen')
  const token = blogApiToken(ws.id, project.id, b)
  if (!token) throw new BlogApiError(b.secret ? 'Zugangsdaten unlesbar, bitte neu eintragen' : 'Token oder Passwort fehlt')
  let error: string | null = null
  try {
    await blogAdapter(b).check(b, token, fetchImpl)
  }
  catch (err) {
    error = err instanceof BlogApiError ? err.message : redactKey((err as Error).message, token).slice(0, 300)
  }
  await setBlogApi(db, project.id, { checkedAt: now().toISOString(), error })
  return { ok: !error, error }
}

export async function scheduleArticle(db: DbOrTx, ws: Workspace, input: { task: Pick<Task, 'id' | 'projectId' | 'title'>, draft: Pick<Draft, 'id'>, mode: 'manual' | 'auto' | 'auto_report', at: Date, userId?: string | null }): Promise<void> {
  await enqueueJob(db, 'publish_article', { workspaceId: ws.id, payload: { taskId: input.task.id, draftId: input.draft.id, mode: input.mode, at: input.at.toISOString() }, dedupeKey: `publish_article:${input.draft.id}`, runAt: input.at, maxAttempts: 1 })
  await logActivity(db, { workspaceId: ws.id, projectId: input.task.projectId, taskId: input.task.id, actor: input.userId ? 'user' : 'agent', userId: input.userId ?? null, action: 'blog_scheduled', detail: { title: input.task.title, at: input.at.toISOString() }, at: now() })
}

async function ownerOf(db: DbOrTx, ws: Workspace, draft: Draft): Promise<string | null> {
  if (draft.approvedByUserId) return draft.approvedByUserId
  const [m] = await db.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, ws.id), eq(schema.memberships.role, 'owner'))).limit(1)
  return m?.u ?? null
}

async function giveBack(db: Db, ws: Workspace, task: Task, draft: Draft, message: string): Promise<void> {
  await db.transaction(async (tx) => {
    const owner = await ownerOf(tx, ws, draft)
    if (draft.status === 'freigegeben') await tx.update(schema.drafts).set({ status: 'offen', approvedAt: null, approvedByUserId: null }).where(eq(schema.drafts.id, draft.id))
    if (['freigegeben', 'geplant', 'entwurf_fertig'].includes(task.status)) await updateTask(tx as unknown as Db, task, { status: 'entwurf_fertig', assigneeUserId: owner ?? task.assigneeUserId }, { type: 'agent' })
    await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Veröffentlichen fehlgeschlagen: ${message}. Bitte prüfen und erneut freigeben oder selbst veröffentlichen.`, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'blog_failed', detail: { title: task.title, error: message.slice(0, 300) }, at: now() })
  })
}

export interface PublishPayload { taskId: string, draftId: string, mode?: string, at?: string, retried?: boolean }

async function articleImage(draft: Draft, project: Project | null, fetchImpl: FetchLike): Promise<ArticleImage | null> {
  const pic = draft.media.find(m => m.mime.startsWith('image/'))
  if (pic) return readMedia(pic).then(data => ({ name: pic.name, mime: pic.mime, data })).catch(() => null)
  if (!project?.url) return null
  try {
    const site = await fetchSite(project.url, { maxPages: 1, timeoutMs: 6000, fetchImpl: fetchImpl as typeof fetch })
    const src = site.pages[0]?.image
    if (!src || /\.svg(\?|$)/i.test(src)) return null
    const img = await fetchImage(src, fetchImpl as typeof fetch)
    const mime = img && sniff(img.data)
    return img && mime?.startsWith('image/') ? { name: img.name, mime, data: img.data } : null
  }
  catch {
    return null
  }
}

function isUpdate(postedUrl: string | null, slugs: string[]): boolean {
  if (!postedUrl) return false
  try {
    const last = new URL(postedUrl).pathname.split('/').filter(Boolean).pop()
    return !!last && slugs.includes(last)
  }
  catch {
    return false
  }
}

export async function publishArticle(db: Db, ws: Workspace, payload: PublishPayload, fetchImpl: FetchLike = fetch): Promise<{ status: 'ok' | 'skipped' | 'error', summary: string }> {
  const [task] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.id, payload.taskId), eq(schema.tasks.workspaceId, ws.id)))
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, payload.draftId))
  if (!task || !draft || draft.taskId !== task.id || draft.status !== 'freigegeben' || task.status !== 'freigegeben') return { status: 'skipped', summary: 'Abgebrochen: Entwurf oder Aufgabe wurde inzwischen geändert' }
  const project = task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  const b = project?.setup?.blogApi
  if (!project || !b || !isArticleTask(task, draft)) {
    await giveBack(db, ws, task, draft, 'Kein Zugang zum Veröffentlichen eingetragen')
    return { status: 'skipped', summary: 'Kein Zugang zum Veröffentlichen' }
  }
  const lateH = payload.at ? (now().getTime() - new Date(payload.at).getTime()) / 3_600_000 : 0
  if (lateH > LATE_HOURS) {
    await giveBack(db, ws, task, draft, `Geplanter Zeitpunkt um ${Math.round(lateH)} Stunden verpasst (App lief nicht), nicht automatisch nachgeholt`)
    return { status: 'skipped', summary: 'Zeitpunkt verpasst, zurück an den Menschen' }
  }
  const mainLang = task.language ?? project.languages?.[0] ?? 'de'
  const adapter = blogAdapter(b)
  const all = articleVersions(draft, mainLang, task.title)
  const skip = adapter.multiLang ? b.skipLangs ?? [] : []
  const known = all.filter(v => !skip.includes(v.lang))
  const versions = adapter.multiLang ? (known.length ? known : all) : all.slice(0, 1)
  if (!versions.length) {
    await giveBack(db, ws, task, draft, 'Titel oder Text fehlt')
    return { status: 'skipped', summary: 'Titel oder Text fehlt' }
  }
  const internal = internalTextProblems(versions.flatMap(v => [v.title, v.body]))
  if (internal.length) {
    await giveBack(db, ws, task, draft, internal.join('; '))
    return { status: 'skipped', summary: `Nicht veröffentlicht: ${internal.join('; ')}` }
  }
  const host = b.type === 'git' && b.git ? `${blogHost(b) ?? b.url} (Commit in ${b.git.repo}, Branch ${b.git.branch})` : blogHost(b) ?? b.url
  const langs = versions.map(v => v.lang.toUpperCase()).join(' und ')
  if (!ws.settings?.publishLive) {
    await db.transaction(async (tx) => {
      await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Trockenlauf: würde jetzt "${versions[0]!.title}" auf ${host} veröffentlichen (${langs}). "Posten nach außen" ist aus, es wurde nichts gesendet.`, createdAt: now() })
      await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'blog_dry_run', detail: { title: task.title }, at: now() })
    })
    return { status: 'ok', summary: `Trockenlauf: würde auf ${host} veröffentlichen` }
  }
  const token = blogApiToken(ws.id, project.id, b)
  if (!token) {
    await giveBack(db, ws, task, draft, 'Token unlesbar, bitte in den Projekt-Einstellungen neu eintragen')
    return { status: 'error', summary: 'Token unlesbar' }
  }
  const key = versions[0]!.slug
  const day = today(ws.timezone)
  const update = isUpdate(task.postedUrl, all.map(v => v.slug))
  const urls: { lang: string, url: string }[] = []
  const notes: string[] = []
  const rejected: string[] = []
  const tokenSafe = (err: unknown) => err instanceof BlogApiError ? err.message : redactKey((err as Error).message, token).slice(0, 300)
  try {
    const wantImage = b.type === 'git' ? !!b.git?.imageDir : b.type === 'wordpress' || !!adapter.uploadImage
    const image = wantImage ? await articleImage(draft, b.type === 'git' ? null : project, fetchImpl) : null
    let imageUrl: string | null = null
    if (image && adapter.uploadImage) {
      try {
        imageUrl = await adapter.uploadImage(b, token, image, fetchImpl)
      }
      catch (err) {
        if (err instanceof BlogRetryError) throw err
        notes.push(`Beitragsbild nicht übernommen: ${tokenSafe(err)}`)
      }
    }
    for (const v of versions) {
      try {
        urls.push({ lang: v.lang, url: (await publishTo(b, token, { key, ...v, date: update ? null : day, updated: day, image: adapter.uploadImage ? null : image, imageUrl, aiGenerated: draft.aiGenerated, mainLang: versions[0]!.lang }, fetchImpl)).url })
      }
      catch (err) {
        if (!(err instanceof BlogLangError)) throw err
        rejected.push(err.lang)
        notes.push(`${err.message}, übersprungen`)
      }
    }
    if (!urls.length) throw new BlogApiError(`Keine Sprache angenommen (${rejected.map(l => l.toUpperCase()).join(', ')}), Sprachen in der Konfiguration der Website prüfen`)
  }
  catch (err) {
    const msg = tokenSafe(err)
    if (urls.length) notes.push(`Schon veröffentlicht: ${urls.map(u => `${u.lang.toUpperCase()} ${u.url}`).join(', ')}`)
    if (notes.length) await db.insert(schema.taskNotes).values(notes.map(text => ({ taskId: task.id, byAgent: true, text, createdAt: now() })))
    if (err instanceof BlogRetryError && !payload.retried) {
      const at = new Date(now().getTime() + Math.max(err.seconds, 5) * 1000)
      await enqueueJob(db, 'publish_article', { workspaceId: ws.id, payload: { ...payload, at: at.toISOString(), retried: true }, dedupeKey: `publish_article:${draft.id}:retry`, runAt: at, maxAttempts: 1 })
      await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Website bremst (429), neuer Versuch um ${at.toISOString().slice(11, 16)} UTC.`, createdAt: now() })
      return { status: 'ok', summary: `Website bremst, neuer Versuch in ${err.seconds} Sekunden` }
    }
    await setBlogApi(db, project.id, { error: msg })
    await giveBack(db, ws, task, draft, msg)
    return { status: 'error', summary: `Veröffentlichen fehlgeschlagen: ${msg}` }
  }
  const report = payload.mode === 'auto_report'
  await db.transaction(async (tx) => {
    await addTaskLinks(tx, task, urls.map(u => ({ platform: `blog:${u.lang}`, url: u.url })))
    await updateTask(tx as unknown as Db, task, { status: 'erledigt', postedUrl: urls[0]!.url }, { type: 'agent' })
    await tx.insert(schema.taskNotes).values([...notes, `${update ? 'Aktualisiert' : 'Veröffentlicht'}: ${urls.map(u => `${u.lang.toUpperCase()} ${u.url}`).join(', ')}`].map(text => ({ taskId: task.id, byAgent: true, text, createdAt: now() })))
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: report ? 'blog_published_report' : 'blog_published', detail: { title: task.title, urls: urls.map(u => u.url), mode: payload.mode ?? 'manual', key }, at: now() })
  })
  await setBlogApi(db, project.id, { lastPublish: now().toISOString(), error: null, ...(rejected.length ? { skipLangs: [...new Set([...skip, ...rejected])] } : {}) })
  return { status: 'ok', summary: `${update ? 'Aktualisiert' : 'Veröffentlicht'}: ${urls.map(u => u.url).join(', ')}${rejected.length ? `, übersprungen: ${rejected.map(l => l.toUpperCase()).join(', ')}` : ''}` }
}

export async function withdrawArticle(db: Db, ws: Workspace, payload: { taskId: string, retried?: boolean }, fetchImpl: FetchLike = fetch): Promise<{ status: 'ok' | 'skipped' | 'error', summary: string }> {
  const [task] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.id, payload.taskId), eq(schema.tasks.workspaceId, ws.id)))
  if (!task || task.status !== 'verworfen' || !task.postedUrl) return { status: 'skipped', summary: 'Nichts zurückzuziehen' }
  const [pub] = await db.select({ id: schema.activity.id }).from(schema.activity).where(and(eq(schema.activity.taskId, task.id), inArray(schema.activity.action, ['blog_published', 'blog_published_report']))).limit(1)
  if (!pub) return { status: 'skipped', summary: 'Nicht über die Schnittstelle veröffentlicht' }
  const project = task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  const b = project?.setup?.blogApi
  const note = (text: string) => db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text, createdAt: now() })
  if (!project || !b) return { status: 'skipped', summary: 'Kein Zugang zum Veröffentlichen' }
  const adapter = blogAdapter(b)
  if (!adapter.withdraw) {
    await note(`Artikel bleibt online (${task.postedUrl}), bitte selbst auf der Website entfernen.`)
    return { status: 'skipped', summary: 'Zurückziehen bei dieser Art nicht möglich' }
  }
  if (!ws.settings?.publishLive) {
    await note(`Trockenlauf: würde den Artikel ${task.postedUrl} jetzt von der Website zurückziehen. "Posten nach außen" ist aus, es wurde nichts gesendet.`)
    await logActivity(db, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'blog_withdraw_dry_run', detail: { title: task.title }, at: now() })
    return { status: 'ok', summary: 'Trockenlauf: würde zurückziehen' }
  }
  const token = blogApiToken(ws.id, project.id, b)
  if (!token) {
    await note(`Zurückziehen nicht möglich: Token unlesbar. Artikel bleibt online (${task.postedUrl}).`)
    return { status: 'error', summary: 'Token unlesbar' }
  }
  try {
    const r = await adapter.withdraw(b, token, task.postedUrl, fetchImpl)
    await note(r.deleted ? `Von der Website zurückgezogen: ${task.postedUrl}` : `Artikel war auf der Website schon entfernt: ${task.postedUrl}`)
    await logActivity(db, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'blog_withdrawn', detail: { title: task.title, url: task.postedUrl }, at: now() })
    return { status: 'ok', summary: r.deleted ? 'Zurückgezogen' : 'War schon entfernt' }
  }
  catch (err) {
    if (err instanceof BlogRetryError && !payload.retried) {
      const at = new Date(now().getTime() + Math.max(err.seconds, 5) * 1000)
      await enqueueJob(db, 'withdraw_article', { workspaceId: ws.id, payload: { taskId: task.id, retried: true }, dedupeKey: `withdraw_article:${task.id}:retry:${at.getTime()}`, runAt: at, maxAttempts: 1 })
      await note(`Website bremst (429), neuer Versuch zum Zurückziehen um ${at.toISOString().slice(11, 16)} UTC.`)
      return { status: 'ok', summary: `Website bremst, neuer Versuch in ${err.seconds} Sekunden` }
    }
    const msg = err instanceof BlogApiError ? err.message : redactKey((err as Error).message, token).slice(0, 300)
    await note(`Zurückziehen fehlgeschlagen: ${msg}. Artikel bleibt online (${task.postedUrl}).`)
    return { status: 'error', summary: `Zurückziehen fehlgeschlagen: ${msg}` }
  }
}

export async function recentAutoArticles(db: DbOrTx, workspaceId: string, sinceDay: string): Promise<string[]> {
  const rows = await db.select({ detail: schema.activity.detail }).from(schema.activity)
    .where(and(eq(schema.activity.workspaceId, workspaceId), inArray(schema.activity.action, ['blog_published_report', 'mail_sent_report']), sql`${schema.activity.createdAt} >= ${sinceDay}::date`))
  return rows.map(r => `${String(r.detail.title ?? '')}${r.detail.to ? ` (Mail an ${String(r.detail.to)})` : ' (Artikel)'}`)
}
