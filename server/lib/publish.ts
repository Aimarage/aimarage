import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { todayIn } from '../../shared/utils/dates'
import { platformOf, taskListedPlatforms, type TaskShape } from '../../shared/utils/drafting'
import { platformRule, postablePlatform, postIssues, textFor, type PostIssue } from '../../shared/utils/social'
import { postText, tagDraft, utmSites } from '../../shared/utils/utm'
import { expectedLangs, internalTextProblems, outboundProblems } from '../../shared/utils/outbound-guard'
import { byReach } from '../../shared/utils/platform-reach'
import { isPlatformBlocked } from '../../shared/utils/blocked-platforms'
import { draftPrivacy } from './privacy'
import type { PostPlatformResult, SocialPostStatus } from '../db/schema'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import { readMedia } from './media'
import { mediaLink, mediaLinkBase } from './media-link'
import { adapterCtx, adapterFor, listConnections, markConnection, noteConnError, openCreds } from './connections'
import { canPublishTask, socialOutlet, type FetchLike, type OutletMedia, type PostOutcome } from './outlets'
import { hostedAccounts, projectAccounts, socialConfig, socialEnvAllowed, type SocialConfig } from './social'
import { addTaskLinks } from './task-links'
import { updateTask } from './tasks'
import './uploadpost'
import { fromZernio } from './zernio'
import { LimitError } from './limits'
import { recordXPost, xBudgetShort } from './service-costs'
import { POST_ERROR } from '../../shared/utils/post-errors'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type Draft = typeof schema.drafts.$inferSelect
type SocialPost = typeof schema.socialPosts.$inferSelect

export class PublishError extends Error {}

// X über gehostetes Zernio kostet je Post (X API pass-through) und zählt ins Dienste-Budget.
export class ServiceBudgetError extends PublishError {}

export function budgetText(short: { needEur: number, leftEur: number }): string {
  return `${POST_ERROR.budget.de} (nötig ca. ${short.needEur.toFixed(2)} EUR, übrig ${short.leftEur.toFixed(2)} EUR)`
}

export async function projectSites(db: DbOrTx, projectId: string | null): Promise<string[]> {
  if (!projectId) return []
  const [p] = await db.select({ url: schema.projects.url, setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, projectId))
  return utmSites(p)
}

export async function withUtm<D extends { body: string, variants?: Record<string, string> | null }>(db: DbOrTx, task: Pick<Task, 'projectId' | 'channel' | 'category' | 'code' | 'title' | 'targetUrl'>, d: D): Promise<D> {
  return task.category === 'social' ? tagDraft(d, await projectSites(db, task.projectId), task) : d
}

export const STATUS_POLL_SEC = 45
export const MAX_STATUS_CHECKS = 60
export const LATE_HOURS = 24

export interface TargetPlatform {
  platform: string
  name: string
  postable: boolean
  via: string
}

export interface SocialTarget {
  cfg: SocialConfig
  profile: string | null
  platforms: TargetPlatform[]
}

export function socialTarget(ws: Workspace, project: Pick<Project, 'setup'> | null): SocialTarget | null {
  if (!project) return null
  const s = ws.settings?.social
  const cfg = socialConfig(s, ws.id, undefined, socialEnvAllowed(ws.settings))
  const assign = project.setup?.social
  const ids = new Set(assign?.accountIds ?? [])
  const platforms: TargetPlatform[] = []
  for (const c of listConnections(ws)) {
    if (!ids.has(c.id) || platforms.some(p => p.platform === c.platform) || !adapterFor(c.provider) || isPlatformBlocked(project, c.platform)) continue
    platforms.push({ platform: c.platform, name: c.name, postable: postablePlatform(c.platform), via: c.id })
  }
  let profile: string | null = null
  if (cfg.apiKey && cfg.provider === 'uploadpost') {
    const accounts = projectAccounts(assign, s?.accounts ?? [])
    profile = assign?.profileIds?.[0] ?? accounts.find(a => a.profileId)?.profileId ?? null
    for (const a of accounts) {
      if (!profile || a.profileId !== profile || platforms.some(p => p.platform === a.platform) || isPlatformBlocked(project, a.platform)) continue
      platforms.push({ platform: a.platform, name: a.name, postable: postablePlatform(a.platform), via: `up:${profile}` })
    }
  }
  if (cfg.apiKey && cfg.provider === 'zernio') {
    const pool = cfg.keySource === 'hosted' ? hostedAccounts(s) : s?.accounts ?? []
    for (const a of projectAccounts(assign, pool)) {
      const platform = fromZernio(a.platform)
      if (platforms.some(p => p.platform === platform) || isPlatformBlocked(project, platform)) continue
      platforms.push({ platform, name: a.name, postable: postablePlatform(platform), via: `zn:${a.id}` })
    }
  }
  if (!platforms.length) return null
  return { cfg, profile, platforms: byReach(platforms, p => p.platform) }
}

export type PlatformTask = Pick<TaskShape, 'title' | 'category' | 'channel' | 'targetUrl' | 'description' | 'channelPlaces'>

export function taskPlatform(task: PlatformTask): string | null {
  const p = platformOf(task)
  return p === 'forum' ? null : p
}

export function targetAccounts(target: SocialTarget | null, task?: PlatformTask): TargetPlatform[] {
  const list = target?.platforms.filter(p => p.postable) ?? []
  const listed: string[] = task?.category === 'social' ? taskListedPlatforms(task) : []
  if (listed.length) return list.filter(p => listed.includes(p.platform))
  const own = task ? taskPlatform(task) : null
  return own ? list.filter(p => p.platform === own) : list
}

export function outletReady(ws: Workspace, project: Pick<Project, 'setup'> | null, task?: PlatformTask): boolean {
  return targetAccounts(socialTarget(ws, project), task).length > 0
}

export function zonedToUtc(date: string, time: string | null, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const [hh, mm] = (time ?? '09:00').split(':').map(Number) as [number, number]
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(guess))
  const g = (t: string) => Number(parts.find(p => p.type === t)?.value)
  const asLocal = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'))
  return new Date(guess - (asLocal - guess))
}

export function plannedAt(task: Pick<Task, 'dueDate' | 'dueTime'>, tz: string): Date {
  const n = now()
  if (!task.dueDate) return n
  const at = zonedToUtc(task.dueDate, task.dueTime, tz)
  return at.getTime() > n.getTime() ? at : n
}

export function chosenPlatforms(draft: Pick<Draft, 'platforms'>, target: SocialTarget, task?: PlatformTask): string[] {
  const avail = target.platforms.filter(p => p.postable).map(p => p.platform)
  if (draft.platforms.length) return draft.platforms.filter(p => avail.includes(p))
  return targetAccounts(target, task).map(p => p.platform)
}

export function draftIssues(draft: Pick<Draft, 'body' | 'variants' | 'media'>, platforms: string[]): Record<string, PostIssue[]> {
  const out: Record<string, PostIssue[]> = {}
  for (const p of platforms) {
    const i = postIssues(p, textFor(p, draft.body, draft.variants), draft.media)
    if (i.length) out[p] = i
  }
  return out
}

export function issueText(issues: Record<string, PostIssue[]>): string {
  const words: Record<PostIssue, string> = { too_long: 'Text zu lang', image_needed: 'Bild oder Video nötig', video_needed: 'Video nötig', not_supported: 'wird nicht automatisch gepostet', empty: 'Text fehlt', placeholder: 'Platzhalter im Text', too_many_media: 'zu viele Bilder oder Videos', media_format: 'Bildformat nicht erlaubt', mixed_media: 'Video nur allein, ohne weitere Bilder' }
  return Object.entries(issues).map(([p, i]) => `${platformRule(p).label}: ${i.map(x => words[x]).join(', ')}`).join('; ')
}

export function validatePost(ws: Workspace, task: Pick<Task, 'category' | 'draftKind' | 'title' | 'channel' | 'targetUrl'>, draft: Pick<Draft, 'platforms' | 'body' | 'variants' | 'media'>, project: Pick<Project, 'setup'> | null): { target: SocialTarget, platforms: string[] } {
  if (!canPublishTask(task)) throw new PublishError('Nur Social-Beiträge werden automatisch gepostet (keine Communities, Foren oder Mails)')
  const target = socialTarget(ws, project)
  if (!target) throw new PublishError('Für dieses Projekt ist kein Social-Konto zugeordnet (Projekt > Konten)')
  const platforms = chosenPlatforms(draft, target, task)
  if (!platforms.length) throw new PublishError('Keine Plattform gewählt bzw. im Projekt verbunden')
  const issues = draftIssues(draft, platforms)
  if (Object.keys(issues).length) throw new PublishError(issueText(issues))
  return { target, platforms }
}

export async function pacedAt(db: DbOrTx, ws: Workspace, project: Pick<Project, 'id' | 'setup'> | null, platforms: string[], at: Date, excludeTaskId?: string): Promise<Date> {
  const max = project?.setup?.pacing?.perPlatformPerDay
  if (!project || !max || max < 1) return at
  let cur = at
  for (let i = 0; i < 14; i++) {
    const day = todayIn(ws.timezone, cur)
    const rows = await db.select({ platforms: schema.socialPosts.platforms, results: schema.socialPosts.results, status: schema.socialPosts.status, at: sql<string>`to_char(${schema.socialPosts.scheduledAt} at time zone ${ws.timezone}, 'YYYY-MM-DD')` }).from(schema.socialPosts)
      .where(and(eq(schema.socialPosts.projectId, project.id), inArray(schema.socialPosts.status, ['geplant', 'laeuft', 'gepostet', 'teilweise']), excludeTaskId ? sql`${schema.socialPosts.taskId} <> ${excludeTaskId}` : undefined))
    const used = (p: string) => rows.filter(r => r.at === day && r.platforms.includes(p) && (r.status === 'geplant' || r.status === 'laeuft' || r.results.some(x => x.platform === p && x.ok))).length
    if (platforms.every(p => used(p) < max)) return cur
    cur = new Date(cur.getTime() + 86_400_000)
  }
  throw new PublishError(`Pacing: höchstens ${max} Post je Plattform und Tag, die nächsten 14 Tage sind voll`)
}

function hostedX(target: SocialTarget, platforms: string[]): boolean {
  return target.cfg.keySource === 'hosted' && platforms.includes('x') && !!target.platforms.find(p => p.platform === 'x')?.via.startsWith('zn:')
}

// Vor Freigabe und Planen: reicht das Dienste-Budget für den X-Post über gehostetes Zernio? null = ja oder nicht betroffen.
export async function xBudgetCheck(db: DbOrTx, ws: Workspace, task: Pick<Task, 'projectId' | 'category' | 'channel' | 'code' | 'title' | 'targetUrl'>, draft: Pick<Draft, 'body' | 'variants'>, target: SocialTarget, platforms: string[]): Promise<{ needEur: number, leftEur: number } | null> {
  if (!hostedX(target, platforms)) return null
  return xBudgetShort(db, ws, [postText('x', draft, await projectSites(db, task.projectId), task)])
}

// Für Freigabe-Wege mit Limit-Dialog: Entwurf bleibt offen, die Oberfläche zeigt den Hinweis mit Zusatzkonto und Tarif.
export async function assertXBudget(db: DbOrTx, ws: Workspace, task: Task, draft: Draft, project: Project | null): Promise<void> {
  let checked: { target: SocialTarget, platforms: string[] }
  try {
    checked = validatePost(ws, task, draft, project)
  }
  catch {
    return
  }
  const short = await xBudgetCheck(db, ws, task, draft, checked.target, checked.platforms)
  if (short) throw new LimitError('servicesEurMonth', budgetText(short))
}

export function providerOf(vias: (string | null | undefined)[]): 'uploadpost' | 'zernio' | 'own' {
  if (vias.length && vias.every(v => v?.startsWith('up:'))) return 'uploadpost'
  if (vias.length && vias.every(v => v?.startsWith('zn:'))) return 'zernio'
  return 'own'
}

export async function schedulePost(db: Db, ws: Workspace, input: { task: Task, draft: Draft, project: Project | null, mode: SocialPost['mode'], at: Date, userId?: string | null }): Promise<SocialPost> {
  const { task, draft } = input
  const { target, platforms } = validatePost(ws, task, draft, input.project)
  const short = await xBudgetCheck(db, ws, task, draft, target, platforms)
  if (short) throw new ServiceBudgetError(budgetText(short))
  input = { ...input, at: await pacedAt(db, ws, input.project, platforms, input.at, task.id) }
  return db.transaction(async (tx) => {
    await tx.update(schema.socialPosts).set({ status: 'abgebrochen', updatedAt: now() }).where(and(eq(schema.socialPosts.taskId, task.id), eq(schema.socialPosts.status, 'geplant')))
    const [row] = await tx.insert(schema.socialPosts).values({
      workspaceId: ws.id,
      projectId: task.projectId,
      taskId: task.id,
      draftId: draft.id,
      provider: providerOf(target.platforms.filter(p => platforms.includes(p.platform)).map(p => p.via)),
      profile: target.profile ?? '',
      platforms,
      results: platforms.map(p => ({ platform: p, ok: null, via: target.platforms.find(x => x.platform === p)!.via })),
      scheduledAt: input.at,
      mode: input.mode,
      createdByUserId: input.userId ?? null,
    }).returning()
    await enqueueJob(tx, 'publish_post', { workspaceId: ws.id, payload: { postId: row!.id, taskId: task.id }, dedupeKey: `publish_post:${row!.id}`, runAt: input.at, maxAttempts: 1 })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: input.userId ? 'user' : 'agent', userId: input.userId ?? null, action: 'social_scheduled', detail: { title: task.title, platforms, at: input.at.toISOString() }, at: now() })
    return row!
  })
}

export async function cancelPosts(db: DbOrTx, taskId: string): Promise<number> {
  const rows = await db.update(schema.socialPosts).set({ status: 'abgebrochen', updatedAt: now() }).where(and(eq(schema.socialPosts.taskId, taskId), eq(schema.socialPosts.status, 'geplant'))).returning({ id: schema.socialPosts.id })
  const mails = await db.update(schema.mails).set({ status: 'abgebrochen' }).where(and(eq(schema.mails.taskId, taskId), eq(schema.mails.status, 'geplant'))).returning({ id: schema.mails.id })
  return rows.length + mails.length
}

async function ownerId(db: DbOrTx, ws: Workspace, post: SocialPost, draft: Draft | null): Promise<string | null> {
  if (post.createdByUserId) return post.createdByUserId
  if (draft?.approvedByUserId) return draft.approvedByUserId
  const [m] = await db.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, ws.id), eq(schema.memberships.role, 'owner'))).limit(1)
  return m?.u ?? null
}

async function setPost(db: DbOrTx, id: string, set: Partial<typeof schema.socialPosts.$inferInsert>): Promise<void> {
  await db.update(schema.socialPosts).set({ ...set, updatedAt: now() }).where(eq(schema.socialPosts.id, id))
}

export async function returnToOwner(db: Db, ws: Workspace, post: SocialPost, message: string): Promise<void> {
  await db.transaction(async (tx) => {
    await setPost(tx, post.id, { status: 'fehler', error: message.slice(0, 1000) })
    const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, post.taskId))
    const [draft] = await tx.select().from(schema.drafts).where(eq(schema.drafts.id, post.draftId))
    if (!task) return
    const owner = await ownerId(tx, ws, post, draft ?? null)
    if (draft && draft.status === 'freigegeben') await tx.update(schema.drafts).set({ status: 'offen', approvedAt: null, approvedByUserId: null }).where(eq(schema.drafts.id, draft.id))
    if (['freigegeben', 'geplant', 'entwurf_fertig'].includes(task.status)) await updateTask(tx as unknown as Db, task, { status: 'entwurf_fertig', assigneeUserId: owner ?? task.assigneeUserId }, { type: 'agent' })
    await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Posten fehlgeschlagen: ${message}. Bitte prüfen und erneut posten oder selbst posten.`, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'social_failed', detail: { title: task.title, error: message.slice(0, 300) }, at: now() })
  })
}

export function finalStatus(results: PostPlatformResult[]): SocialPostStatus {
  const ok = results.filter(r => r.ok).length
  if (!ok) return 'fehler'
  return ok === results.length ? 'gepostet' : 'teilweise'
}

export function mergeResults(platforms: string[], prev: PostPlatformResult[], next: PostPlatformResult[]): PostPlatformResult[] {
  return platforms.map((p) => {
    const n = next.find(r => r.platform === p)
    const o = prev.find(r => r.platform === p)
    return { platform: p, ok: n?.ok ?? o?.ok ?? null, url: n?.url ?? o?.url ?? null, postId: n?.postId ?? o?.postId ?? null, error: n?.error ?? o?.error ?? null, via: n?.via ?? o?.via ?? null }
  })
}

// Kosten des X-Posts erfassen, wenn er über gehostetes Zernio rausging (eigene Schlüssel zahlen selbst).
async function recordHostedX(db: Db, ws: Workspace, post: SocialPost, results: PostPlatformResult[]): Promise<void> {
  if (!results.some(r => r.platform === 'x' && r.ok && r.via?.startsWith('zn:'))) return
  if (socialConfig(ws.settings?.social, ws.id, undefined, socialEnvAllowed(ws.settings)).keySource !== 'hosted') return
  try {
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, post.taskId))
    const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, post.draftId))
    const text = draft && task ? postText('x', draft, await projectSites(db, task.projectId), task) : ''
    await recordXPost(db, ws.id, [text || 'x'])
  }
  catch (err) {
    console.error('[publish] X-Kosten nicht erfasst:', (err as Error).message)
  }
}

async function finish(db: Db, ws: Workspace, post: SocialPost, outcome: PostOutcome): Promise<string> {
  const results = mergeResults(post.platforms, post.results, outcome.results).map(r => (r.ok === null ? { ...r, ok: outcome.state === 'done' ? false : null, error: r.error ?? 'keine Rückmeldung' } : r))
  const status = outcome.state === 'failed' && !results.some(r => r.ok) ? 'fehler' : finalStatus(results)
  const errors = results.filter(r => !r.ok).map(r => `${platformRule(r.platform).label}: ${r.error ?? 'fehlgeschlagen'}`)
  if (status === 'fehler') {
    await setPost(db, post.id, { results, requestId: outcome.requestId ?? post.requestId })
    await returnToOwner(db, ws, post, errors.join('; ') || outcome.error || 'fehlgeschlagen')
    return `Posten fehlgeschlagen: ${errors.join('; ') || outcome.error}`
  }
  await recordHostedX(db, ws, post, results)
  const urls = results.filter(r => r.ok && r.url).map(r => r.url!)
  await db.transaction(async (tx) => {
    await setPost(tx, post.id, { status, results, requestId: outcome.requestId ?? post.requestId, postedAt: now(), error: errors.length ? errors.join('; ').slice(0, 1000) : null })
    const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, post.taskId))
    if (!task) return
    await addTaskLinks(tx, task, results.filter(r => r.ok && r.url).map(r => ({ platform: r.platform, url: r.url })))
    if (task.status !== 'erledigt' && task.status !== 'ausgewertet') await updateTask(tx as unknown as Db, task, { status: 'erledigt', postedUrl: urls[0] ?? task.postedUrl }, { type: 'agent' })
    const okList = results.filter(r => r.ok).map(r => `${platformRule(r.platform).label}${r.url ? ` ${r.url}` : ''}${r.error ? ` (${r.error})` : ''}`).join(', ')
    await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Gepostet: ${okList}${errors.length ? `. Fehlgeschlagen: ${errors.join('; ')}` : ''}`, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: post.mode === 'auto_report' ? 'social_posted_report' : 'social_posted', detail: { title: task.title, platforms: results.filter(r => r.ok).map(r => r.platform), urls, mode: post.mode }, at: now() })
    if (errors.length) await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'social_failed', detail: { title: task.title, error: errors.join('; ').slice(0, 300) }, at: now() })
  })
  return `Gepostet (${results.filter(r => r.ok).map(r => r.platform).join(', ')})${errors.length ? `, Fehler: ${errors.join('; ')}` : ''}`
}

export async function publishPost(db: Db, ws: Workspace, postId: string, fetchImpl?: FetchLike): Promise<{ status: 'ok' | 'skipped' | 'error', summary: string }> {
  const claimed = await db.update(schema.socialPosts).set({ status: 'laeuft', updatedAt: now() }).where(and(eq(schema.socialPosts.id, postId), eq(schema.socialPosts.workspaceId, ws.id), eq(schema.socialPosts.status, 'geplant'))).returning()
  const post = claimed[0]
  if (!post) return { status: 'skipped', summary: 'Beitrag nicht mehr geplant' }
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, post.taskId))
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, post.draftId))
  const earlier = task ? await db.select({ results: schema.socialPosts.results }).from(schema.socialPosts).where(and(eq(schema.socialPosts.taskId, task.id), eq(schema.socialPosts.status, 'gepostet'))) : []
  const alreadyPosted = new Set(earlier.flatMap(e => e.results.filter(r => r.ok).map(r => r.platform)))
  const followUp = task?.status === 'erledigt' && alreadyPosted.size > 0
  if (!task || !draft || draft.status !== 'freigegeben' || (task.status !== 'freigegeben' && !followUp)) {
    await setPost(db, post.id, { status: 'abgebrochen', error: 'Entwurf oder Aufgabe wurde inzwischen geändert' })
    return { status: 'skipped', summary: 'Abgebrochen: Entwurf oder Aufgabe wurde inzwischen geändert' }
  }
  if (post.platforms.length && post.platforms.every(p => alreadyPosted.has(p))) {
    await setPost(db, post.id, { status: 'abgebrochen', error: 'Auf diesen Plattformen schon gepostet' })
    return { status: 'skipped', summary: 'Abgebrochen: auf diesen Plattformen schon gepostet' }
  }
  if (!canPublishTask(task)) {
    await returnToOwner(db, ws, post, 'Diese Art wird nie automatisch gepostet')
    return { status: 'skipped', summary: 'Nicht erlaubt: keine Social-Aufgabe' }
  }
  const lateH = (now().getTime() - post.scheduledAt.getTime()) / 3_600_000
  if (lateH > LATE_HOURS) {
    await returnToOwner(db, ws, post, `Geplanter Zeitpunkt um ${Math.round(lateH)} Stunden verpasst (App lief nicht), nicht automatisch nachgeholt`)
    return { status: 'skipped', summary: 'Zeitpunkt verpasst, zurück an den Menschen' }
  }
  const platforms = post.platforms.filter(postablePlatform).filter(p => !alreadyPosted.has(p))
  const site = await projectSites(db, task.projectId)
  const texts = Object.fromEntries(platforms.map(p => [p, postText(p, draft, site, task)]))
  const issues = draftIssues({ ...draft, variants: texts }, platforms)
  if (!platforms.length || Object.keys(issues).length) {
    await returnToOwner(db, ws, post, platforms.length ? issueText(issues) : 'Keine erlaubte Plattform')
    return { status: 'skipped', summary: `Nicht gepostet: ${issueText(issues) || 'keine Plattform'}` }
  }
  const human = post.mode === 'manual' && !!post.createdByUserId
  const outTexts = [draft.subject, ...Object.values(texts)]
  const proj = task.projectId ? (await db.select({ languages: schema.projects.languages, url: schema.projects.url }).from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  const guard = human ? internalTextProblems(outTexts) : [...outboundProblems(outTexts, expectedLangs(task, proj)), ...draftPrivacy(proj, { kind: 'post', subject: draft.subject, body: Object.values(texts).join('\n') })]
  if (guard.length) {
    await returnToOwner(db, ws, post, guard.join('; '))
    return { status: 'skipped', summary: `Nicht gepostet: ${guard.join('; ')}` }
  }
  const labels = platforms.map(p => platformRule(p).label).join(', ')
  if (!ws.settings?.publishLive) {
    await db.transaction(async (tx) => {
      await setPost(tx, post.id, { status: 'trocken', dryRun: true })
      await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Trockenlauf: würde jetzt auf ${labels} posten. "Posten nach außen" ist aus, es wurde nichts gesendet.`, createdAt: now() })
      await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'social_dry_run', detail: { title: task.title, platforms, profile: post.profile }, at: now() })
    })
    return { status: 'ok', summary: `Trockenlauf: würde posten auf ${labels}` }
  }
  let media
  try {
    const base = mediaLinkBase()
    media = await Promise.all(draft.media.map(async m => ({ name: m.name, mime: m.mime, data: await readMedia(m), url: base ? mediaLink(m, base) : null })))
  }
  catch {
    await returnToOwner(db, ws, post, 'Bild/Video-Datei fehlt auf dem Rechner')
    return { status: 'error', summary: 'Mediendatei fehlt' }
  }
  const viaOf = (p: string) => post.results.find(r => r.platform === p)?.via ?? (post.provider === 'uploadpost' ? `up:${post.profile}` : null)
  const own = platforms.filter(p => !viaOf(p)?.startsWith('up:') && !viaOf(p)?.startsWith('zn:'))
  const viaUp = platforms.filter(p => viaOf(p)?.startsWith('up:'))
  const viaZn = platforms.filter(p => viaOf(p)?.startsWith('zn:'))
  const results: PostPlatformResult[] = []
  for (const p of own) results.push(await postOwn(db, ws, p, viaOf(p), { text: texts[p]!, media, title: draft.subject, aiGenerated: draft.aiGenerated }, fetchImpl))
  let upOutcome: PostOutcome | null = null
  if (viaUp.length) {
    const cfg = socialConfig(ws.settings?.social, ws.id, undefined, socialEnvAllowed(ws.settings))
    const outlet = socialOutlet('uploadpost')
    const profile = viaOf(viaUp[0]!)!.slice(3)
    if (!outlet || !cfg.apiKey || cfg.provider !== 'uploadpost') {
      for (const p of viaUp) results.push({ platform: p, ok: false, error: 'Upload-Post nicht mehr verbunden', via: viaOf(p) })
    }
    else {
      try {
        upOutcome = await outlet.post(cfg, { profile, platforms: viaUp, text: draft.body, variants: { ...draft.variants, ...texts }, media, at: null, timezone: ws.timezone, externalId: post.id, aiGenerated: draft.aiGenerated }, fetchImpl)
        results.push(...upOutcome.results.filter(r => viaUp.includes(r.platform)).map(r => ({ ...r, via: viaOf(r.platform) })))
      }
      catch (err) {
        for (const p of viaUp) results.push({ platform: p, ok: false, error: (err as Error).message, via: viaOf(p) })
      }
    }
  }
  if (viaZn.length) {
    const cfg = socialConfig(ws.settings?.social, ws.id, undefined, socialEnvAllowed(ws.settings))
    const outlet = socialOutlet('zernio')
    const pool = cfg.keySource === 'hosted' ? hostedAccounts(ws.settings?.social) : ws.settings?.social?.accounts ?? []
    const accounts = Object.fromEntries(viaZn.map(p => [p, viaOf(p)!.slice(3)]).filter(([, id]) => pool.some(a => a.id === id)))
    const missing = viaZn.filter(p => !accounts[p])
    for (const p of missing) results.push({ platform: p, ok: false, error: 'Konto nicht mehr verbunden', via: viaOf(p) })
    let go = viaZn.filter(p => accounts[p])
    if (cfg.keySource === 'hosted' && go.includes('x')) {
      const short = await xBudgetShort(db, ws, [texts.x ?? ''])
      if (short) {
        results.push({ platform: 'x', ok: false, error: budgetText(short), via: viaOf('x') })
        go = go.filter(p => p !== 'x')
      }
    }
    if (!outlet || !cfg.apiKey || cfg.provider !== 'zernio') {
      for (const p of go) results.push({ platform: p, ok: false, error: POST_ERROR.noService.de, via: viaOf(p) })
    }
    else if (go.length) {
      try {
        upOutcome = await outlet.post(cfg, { profile: cfg.profileId ?? '', platforms: go, text: draft.body, variants: { ...draft.variants, ...texts }, media, at: null, timezone: ws.timezone, externalId: post.id, accounts, aiGenerated: draft.aiGenerated }, fetchImpl)
        results.push(...upOutcome.results.filter(r => go.includes(r.platform)).map(r => ({ ...r, via: viaOf(r.platform) })))
      }
      catch (err) {
        for (const p of go) results.push({ platform: p, ok: false, error: (err as Error).message, via: viaOf(p) })
      }
    }
  }
  const merged = mergeResults(post.platforms, post.results, results)
  if (upOutcome && (upOutcome.state === 'pending' || upOutcome.state === 'scheduled')) {
    await setPost(db, post.id, { requestId: upOutcome.requestId, results: merged })
    await enqueueJob(db, 'publish_status', { workspaceId: ws.id, payload: { postId: post.id, taskId: task.id }, dedupeKey: `publish_status:${post.id}:1`, runAt: new Date(now().getTime() + STATUS_POLL_SEC * 1000), maxAttempts: 3 })
    return { status: 'ok', summary: `Gesendet: ${labels}${viaUp.length ? ', warte auf Rückmeldung von Upload-Post' : viaZn.length ? ', warte auf Rückmeldung' : ''}` }
  }
  const anyOk = merged.some(r => r.ok)
  const summary = await finish(db, ws, post, { state: anyOk ? 'done' : 'failed', requestId: upOutcome?.requestId ?? null, results: merged, error: anyOk ? null : merged.map(r => r.error).filter(Boolean).join('; ') })
  return { status: anyOk ? 'ok' : 'error', summary }
}

async function postOwn(db: Db, ws: Workspace, platform: string, via: string | null, req: { text: string, media: OutletMedia[], title: string | null, aiGenerated: boolean }, fetchImpl?: FetchLike): Promise<PostPlatformResult> {
  const conn = listConnections(ws).find(c => c.id === via)
  const adapter = conn ? adapterFor(conn.provider) : null
  if (!conn || !adapter) return { platform, ok: false, error: 'Konto nicht mehr verbunden', via }
  const creds = openCreds(ws.id, conn)
  if (!creds) return { platform, ok: false, error: 'Zugangsdaten unlesbar, bitte Konto neu verbinden', via }
  try {
    const r = await adapter.post(conn, creds, { ...req, link: null }, adapterCtx(db, ws, conn, fetchImpl))
    if (r.ok && conn.error) await markConnection(db, ws.id, conn.id, { error: null, checkedAt: new Date().toISOString() })
    return { ...r, platform, via }
  }
  catch (err) {
    const msg = await noteConnError(db, ws.id, conn, (err as Error).message)
    return { platform, ok: false, error: msg, via }
  }
}

export async function checkPostStatus(db: Db, ws: Workspace, postId: string, fetchImpl?: FetchLike): Promise<{ status: 'ok' | 'skipped' | 'error', summary: string }> {
  const [post] = await db.select().from(schema.socialPosts).where(and(eq(schema.socialPosts.id, postId), eq(schema.socialPosts.workspaceId, ws.id)))
  if (!post || post.status !== 'laeuft' || !post.requestId) return { status: 'skipped', summary: 'Kein laufender Beitrag' }
  const cfg = socialConfig(ws.settings?.social, ws.id, undefined, socialEnvAllowed(ws.settings))
  const viaZernio = post.provider === 'zernio' || post.results.some(r => r.via?.startsWith('zn:'))
  const outlet = socialOutlet(viaZernio ? 'zernio' : 'uploadpost')
  if (!outlet || !cfg.apiKey || cfg.provider !== (viaZernio ? 'zernio' : 'uploadpost')) return { status: 'skipped', summary: 'Dienst nicht verbunden' }
  const checks = post.checks + 1
  let outcome: PostOutcome
  try {
    outcome = await outlet.status(cfg, post.requestId, fetchImpl)
  }
  catch (err) {
    outcome = { state: 'pending', requestId: post.requestId, results: [], error: (err as Error).message }
  }
  if (outcome.state === 'pending' || outcome.state === 'scheduled') {
    if (checks >= MAX_STATUS_CHECKS) {
      await setPost(db, post.id, { checks })
      await returnToOwner(db, ws, { ...post, checks }, viaZernio ? `${POST_ERROR.noAnswer.de} nach ${checks} Abfragen` : `Keine Rückmeldung von ${outlet.label} nach ${checks} Abfragen${outcome.error ? ` (${outcome.error})` : ''}`)
      return { status: 'error', summary: 'Keine Rückmeldung, zurück an den Menschen' }
    }
    await setPost(db, post.id, { checks, results: mergeResults(post.platforms, post.results, outcome.results) })
    const wait = Math.min(15 * 60, STATUS_POLL_SEC * Math.ceil(checks / 4))
    await enqueueJob(db, 'publish_status', { workspaceId: ws.id, payload: { postId: post.id, taskId: post.taskId }, dedupeKey: `publish_status:${post.id}:${checks + 1}`, runAt: new Date(now().getTime() + wait * 1000), maxAttempts: 3 })
    return { status: 'ok', summary: `Noch in Arbeit (${checks}. Abfrage)` }
  }
  await setPost(db, post.id, { checks })
  return { status: outcome.state === 'failed' ? 'error' : 'ok', summary: await finish(db, ws, { ...post, checks }, outcome) }
}

const STAT_METRICS = ['reach', 'views', 'likes', 'comments', 'shares', 'clicks'] as const

export async function collectStats(db: Db, ws: Workspace, fetchImpl?: FetchLike): Promise<{ posts: number, values: number, followers: number, errors: string[] }> {
  const d = today(ws.timezone)
  const since = new Date(now().getTime() - 30 * 86_400_000)
  const posts = await db.select().from(schema.socialPosts).where(and(eq(schema.socialPosts.workspaceId, ws.id), inArray(schema.socialPosts.status, ['gepostet', 'teilweise']), eq(schema.socialPosts.dryRun, false), gte(schema.socialPosts.postedAt, since))).orderBy(desc(schema.socialPosts.postedAt)).limit(100)
  const cfg = socialConfig(ws.settings?.social, ws.id, undefined, socialEnvAllowed(ws.settings))
  const up = cfg.apiKey && cfg.provider === 'uploadpost' ? socialOutlet('uploadpost') : null
  const conns = listConnections(ws)
  const errors: string[] = []
  let values = 0
  let n = 0
  for (const p of posts) {
    const sums: Record<string, number> = {}
    const add = (m: Record<string, number>) => {
      for (const [k, v] of Object.entries(m)) sums[k] = (sums[k] ?? 0) + v
    }
    const okResults = p.results.filter(r => r.ok)
    if (up && p.requestId && okResults.some(r => r.via?.startsWith('up:') || (!r.via && p.provider === 'uploadpost'))) {
      try {
        for (const s of await up.stats(cfg, p.requestId, fetchImpl)) add(s.metrics)
      }
      catch (err) {
        errors.push((err as Error).message)
      }
    }
    for (const r of okResults) {
      const conn = conns.find(c => c.id === r.via)
      const adapter = conn ? adapterFor(conn.provider) : null
      const creds = conn ? openCreds(ws.id, conn) : null
      if (!conn || !adapter?.stats || !creds) continue
      try {
        add(await adapter.stats(conn, creds, { postId: r.postId ?? null, url: r.url ?? null }, adapterCtx(db, ws, conn, fetchImpl)))
      }
      catch (err) {
        errors.push(`${platformRule(r.platform).label}: ${(err as Error).message}`)
      }
    }
    if (sums.views !== undefined && sums.reach === undefined) sums.reach = sums.views
    delete sums.views
    if (!Object.keys(sums).length) continue
    await db.transaction(async (tx) => {
      for (const k of STAT_METRICS) {
        const v = sums[k]
        if (v === undefined) continue
        await tx.delete(schema.results).where(and(eq(schema.results.taskId, p.taskId), eq(schema.results.metric, k), eq(schema.results.source, 'social')))
        await tx.insert(schema.results).values({ taskId: p.taskId, metric: k, value: v, note: `Stand ${d}: ${okResults.map(r => platformRule(r.platform).label).join(', ')}`, source: 'social', measuredOn: d })
        values++
      }
      await tx.update(schema.socialPosts).set({ statsAt: now() }).where(eq(schema.socialPosts.id, p.id))
    })
    n++
  }
  let followers = 0
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))
  for (const pr of projects) {
    const target = socialTarget(ws, pr)
    if (!target) continue
    let total = 0
    let found = false
    for (const tp of target.platforms) {
      const conn = conns.find(c => c.id === tp.via)
      const adapter = conn ? adapterFor(conn.provider) : null
      const creds = conn ? openCreds(ws.id, conn) : null
      if (!conn || !adapter?.followers || !creds) continue
      try {
        const f = await adapter.followers(conn, creds, adapterCtx(db, ws, conn, fetchImpl))
        if (f !== null) {
          total += f
          found = true
        }
      }
      catch (err) {
        errors.push(`${conn.name}: ${(err as Error).message}`)
      }
    }
    const upPlatforms = target.platforms.filter(x => x.via.startsWith('up:')).map(x => x.platform)
    if (up && target.profile && upPlatforms.length) {
      try {
        const by = await up.profileStats(cfg, target.profile, upPlatforms, fetchImpl)
        for (const m of Object.values(by)) {
          if (m.followers !== undefined) {
            total += m.followers
            found = true
          }
        }
      }
      catch (err) {
        errors.push(`${pr.name}: ${(err as Error).message}`)
      }
    }
    if (!found) continue
    await db.insert(schema.metrics).values({ projectId: pr.id, key: 'followers', day: d, value: total, source: 'social' })
      .onConflictDoUpdate({ target: [schema.metrics.projectId, schema.metrics.key, schema.metrics.day], set: { value: total, source: 'social' } })
    followers++
  }
  return { posts: n, values, followers, errors }
}

export async function recentAutoPosts(db: DbOrTx, workspaceId: string, sinceDay: string): Promise<string[]> {
  const rows = await db.select({ title: schema.tasks.title, platforms: schema.socialPosts.platforms }).from(schema.socialPosts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.socialPosts.taskId))
    .where(and(eq(schema.socialPosts.workspaceId, workspaceId), eq(schema.socialPosts.mode, 'auto_report'), inArray(schema.socialPosts.status, ['gepostet', 'teilweise']), sql`${schema.socialPosts.postedAt} >= ${sinceDay}::date`))
  return rows.map(r => `${r.title} (${r.platforms.map(p => platformRule(p).label).join(', ')})`)
}
