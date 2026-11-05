import { createHash } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { mailRelevant } from '../../shared/utils/coldmail'
import { roleAtLeast, type Role } from '../../shared/utils/domain'
import { checkDraft, issueLabel, platformOf, taskType, type CheckCode } from '../../shared/utils/drafting'
import { linksIn, MCP_MAX_LINKS, MCP_MIN_REASON, mcpApproveConfig, mcpKindOf, textProblems, type McpApproveConfig } from '../../shared/utils/mcp-approve'
import { repliesItself } from '../../shared/utils/listening'
import { draftChecks } from '../../shared/utils/talk'
import { DraftStateError, applyDraftAction } from '../services/drafts'
import { logActivity } from './activity'
import { projectFacts } from './agent'
import { blogApiReady, isArticleTask, scheduleArticle } from './blog-api'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { canPublishTask, type FetchLike } from './outlets'
import { cancelPosts, outletReady, plannedAt, PublishError, schedulePost, socialTarget, targetAccounts, validatePost, zonedToUtc } from './publish'
import { withChannelPlaces } from './channel-places'
import { HUMAN_ONLY, MailError, mailReady, scheduleSend, singleRecipient } from './mail'
import { expectedLangs, internalTextProblems, languageProblem } from '../../shared/utils/outbound-guard'
import { assertPublicHost } from './site'
import { updateTask } from './tasks'
import { releaseExempt, releaseFocusFor } from './release-focus'
import { replyAccount } from './listen-account'
import { draftPrivacy } from './privacy'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type Draft = typeof schema.drafts.$inferSelect

export class McpApproveError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

const BLOCK_CODES: CheckCode[] = ['placeholder', 'rule_term', 'too_long', 'wrong_kind', 'missing_subject', 'missing_title', 'instagram_link', 'old_release']

export function draftStamp(d: Pick<Draft, 'version' | 'body' | 'subject' | 'recipient' | 'targetUrl' | 'variants' | 'platforms' | 'media'>): string {
  const variants = Object.keys(d.variants ?? {}).sort().map(k => [k, d.variants[k]])
  const raw = JSON.stringify([d.body, d.subject, d.recipient, d.targetUrl, variants, d.platforms, d.media.map(m => m.id)])
  return `v${d.version}-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}

export function mcpConfig(ws: Pick<Workspace, 'settings'>): McpApproveConfig {
  return mcpApproveConfig(ws.settings?.mcpApprove)
}

export function goesOut(ws: Workspace, project: Project | null, task: Task, draft: Draft): boolean {
  const reply = replyAccount(ws, project, task)
  if (reply) return reply.connected
  if (draft.kind === 'mail') return mailReady(project)
  if (isArticleTask(task, draft)) return blogApiReady(project)
  return canPublishTask(task) && outletReady(ws, project, task)
}

function dayStart(ws: Workspace): Date {
  return zonedToUtc(today(ws.timezone), '00:00', ws.timezone)
}

export async function approvedToday(db: DbOrTx, ws: Workspace, action = 'mcp_approved'): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.activity)
    .where(and(eq(schema.activity.workspaceId, ws.id), eq(schema.activity.action, action), gte(schema.activity.createdAt, dayStart(ws))))
  return r?.n ?? 0
}

export interface McpReview {
  stand: string
  allowed: boolean
  blockers: string[]
  hints: string[]
  infoNeeded: string[]
  links: string[]
}

// Plattformen, auf die der Entwurf wirklich geht: seine eigene Liste, sonst die der Aufgabe (Titel, Beschreibung, Orte des Kanals), nicht alle verbundenen Konten.
async function draftPlatforms(db: DbOrTx, target: ReturnType<typeof socialTarget>, task: Task, draft: Draft): Promise<string[]> {
  const avail = target?.platforms.filter(p => p.postable).map(p => p.platform) ?? []
  if (draft.platforms.length) return draft.platforms.filter(p => avail.includes(p))
  const [placed] = await withChannelPlaces(db, [task])
  return targetAccounts(target, placed).map(p => p.platform)
}

// via 'reviewer': der KI-Prüfer im Server, eigene Arten (nie Mail) statt der MCP-Einstellungen, offene Nachprüfungen blockieren.
export async function reviewForMcp(db: DbOrTx, ws: Workspace, task: Task, draft: Draft, project: Project | null, opts: { via?: 'mcp' | 'reviewer', kinds?: readonly string[] } = {}): Promise<McpReview> {
  const cfg = mcpConfig(ws)
  const reviewer = opts.via === 'reviewer'
  const blockers: string[] = []
  const hints: string[] = []
  if (!reviewer && !cfg.enabled) blockers.push('Freigeben über MCP ist in Aimarage ausgeschaltet (Einstellungen > Arbeitsbereich)')
  if (!reviewer && project && cfg.offProjects.includes(project.id)) blockers.push('Für dieses Projekt ist Freigeben über MCP aus')
  const kind = mcpKindOf(task, draft)
  if (!kind || (kind !== 'mail' && mailRelevant({ category: task.category, draftKind: draft.kind }))) blockers.push('Diese Art gibt nur der Mensch frei (Erstmails, Kaltakquise, Kosten, Werbung, Strategie, Konten)')
  else if (!(reviewer ? opts.kinds ?? [] : cfg.kinds).includes(kind)) blockers.push(`Art "${kind}" ist für Freigeben ${reviewer ? 'durch den KI-Prüfer' : 'über MCP'} nicht erlaubt`)
  if (kind === 'mail' || draft.kind === 'mail') blockers.push(HUMAN_ONLY)
  if (kind === 'mail') blockers.push(...await mailReplyProblems(db, ws, task, draft))
  if (draft.status !== 'offen') blockers.push(`Entwurf ist ${draft.status}`)
  const notes = await db.select({ id: schema.taskNotes.id, text: schema.taskNotes.text, byAgent: schema.taskNotes.byAgent, createdAt: schema.taskNotes.createdAt }).from(schema.taskNotes)
    .where(and(eq(schema.taskNotes.taskId, task.id), eq(schema.taskNotes.byAgent, true)))
  const checks = draftChecks(notes, draft.createdAt)
  const infoNeeded = checks.filter(c => c.kind === 'info').map(c => c.text)
  if (infoNeeded.length) blockers.push(`Info nötig: ${infoNeeded.join('; ')}`)
  for (const c of checks.filter(c => c.kind === 'check')) (reviewer ? blockers : hints).push(`Nachprüfung: ${c.text}`)
  const texts = [draft.subject, draft.body, ...Object.values(draft.variants ?? {})]
  blockers.push(...textProblems(texts))
  blockers.push(...internalTextProblems(texts))
  blockers.push(...draftPrivacy(project, draft))
  const lang = languageProblem(draft.body, expectedLangs(task, project))
  if (lang) blockers.push(lang)
  const target = socialTarget(ws, project)
  const d = today(ws.timezone)
  const focus = project ? await releaseFocusFor(db, project.id, task.dueDate && task.dueDate > d ? task.dueDate : d) : null
  const release = focus && !(await releaseExempt(db, task, focus)) ? focus : null
  const issues = checkDraft({
    type: taskType(task),
    category: task.category,
    kind: draft.kind,
    subject: draft.subject,
    body: draft.body,
    variants: draft.variants,
    platform: platformOf(task),
    recent: [],
    rules: project?.rules ?? null,
    avoid: projectFacts(project).avoid,
    platforms: task.category === 'social' ? await draftPlatforms(db, target, task, draft) : [],
    release,
  })
  for (const i of issues) (BLOCK_CODES.includes(i.code) ? blockers : hints).push(issueLabel(i))
  if (canPublishTask(task) && outletReady(ws, project, task)) {
    try {
      validatePost(ws, task, draft, project)
    }
    catch (err) {
      if (err instanceof PublishError) blockers.push(err.message)
      else throw err
    }
  }
  const links = linksIn(texts)
  if (links.length > MCP_MAX_LINKS) blockers.push(`Mehr als ${MCP_MAX_LINKS} Links, bitte selbst prüfen`)
  return { stand: draftStamp(draft), allowed: !blockers.length, blockers: [...new Set(blockers)], hints: [...new Set(hints)], infoNeeded, links }
}

export async function mailReplyProblems(db: DbOrTx, ws: Workspace, task: Task, draft: Draft): Promise<string[]> {
  if (task.category === 'outreach' || task.category === 'community') return ['Kaltakquise und Community-Mails gibt nur der Mensch frei']
  const [incoming] = await db.select().from(schema.mails)
    .where(and(eq(schema.mails.taskId, task.id), eq(schema.mails.direction, 'in'), isNotNull(schema.mails.fromAddr)))
    .orderBy(desc(schema.mails.createdAt)).limit(1)
  if (!incoming) return ['Keine eingegangene Mail zu dieser Aufgabe: Erstmails und Einsendungen gibt nur der Mensch frei']
  if (!incoming.inReplyTo && !incoming.messageId) return ['Eingegangene Mail ohne Message-ID: Antwort nicht zuordenbar']
  const out: string[] = []
  let to: string | null = null
  try {
    to = singleRecipient(draft.recipient)
  }
  catch (err) {
    if (!(err instanceof MailError)) throw err
    out.push(`Empfänger: ${err.message}`)
  }
  const from = incoming.fromAddr!.toLowerCase()
  if (to && to !== from) out.push(`Empfänger ${to} ist nicht der Absender der eingegangenen Mail (${from}): nur Antworten an den Absender`)
  const addrs = [...new Set([from, to].filter((a): a is string => !!a))]
  const blocked = await db.select({ name: schema.contacts.name }).from(schema.contacts)
    .where(and(eq(schema.contacts.workspaceId, ws.id), eq(schema.contacts.status, 'gesperrt'), inArray(sql`lower(${schema.contacts.email})`, addrs)))
  const byId = incoming.contactId ? await db.select({ name: schema.contacts.name }).from(schema.contacts).where(and(eq(schema.contacts.id, incoming.contactId), eq(schema.contacts.status, 'gesperrt'))) : []
  for (const c of [...blocked, ...byId]) out.push(`${c.name} ist gesperrt, keine Mails an diesen Kontakt`)
  return out
}

function reachable(status: number): boolean {
  return (status >= 200 && status < 400) || status === 401 || status === 403
}

export async function checkLinks(urls: string[], fetchImpl: FetchLike = fetch, timeoutMs = 8000): Promise<string[]> {
  const bad = await Promise.all(urls.slice(0, MCP_MAX_LINKS).map(async (url) => {
    try {
      await assertPublicHost(url)
      const call = async (method: 'HEAD' | 'GET') => {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), timeoutMs)
        try {
          const res = await fetchImpl(url, { method, redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'Aimarage-Linkcheck/1.0' } })
          await res.body?.cancel().catch(() => {})
          return res.status
        }
        finally {
          clearTimeout(timer)
        }
      }
      let status = await call('HEAD').catch(() => 0)
      if (!reachable(status)) status = await call('GET').catch(() => 0)
      return reachable(status) ? null : `${url} (${status || 'nicht erreichbar'})`
    }
    catch (err) {
      return `${url} (${(err as Error).message})`
    }
  }))
  return bad.filter((x): x is string => !!x)
}

export interface McpApprover {
  userId: string
  role: Role
  canApprove: boolean
}

export interface McpApproveResult {
  draftId: string
  code: string
  releaseAt: string
  goesOut: boolean
  remainingToday: number
}

export async function approveViaMcp(db: Db, wsIn: Workspace, who: McpApprover, input: { draftId: string, stand: string, reason: string }, fetchImpl: FetchLike = fetch): Promise<McpApproveResult> {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsIn.id))
  if (!ws) throw new McpApproveError(404, 'Arbeitsbereich nicht gefunden')
  if (!who.canApprove) throw new McpApproveError(403, 'Dieser Zugang darf nicht freigeben (MCP-Schlüssel mit Recht "freigeben" in Aimarage erzeugen)')
  if (!roleAtLeast(who.role, 'member')) throw new McpApproveError(403, 'Keine Berechtigung zum Freigeben')
  const cfg = mcpConfig(ws)
  if (!cfg.enabled) throw new McpApproveError(403, 'Freigeben über MCP ist in Aimarage ausgeschaltet (Einstellungen > Arbeitsbereich)')
  const reason = input.reason.replace(/[–—]/g, '-').trim()
  if (reason.length < MCP_MIN_REASON) throw new McpApproveError(400, `Prüfung zu kurz: mindestens ${MCP_MIN_REASON} Zeichen, was du geprüft hast`)
  const used = await approvedToday(db, ws)
  if (used >= cfg.perDay) throw new McpApproveError(429, `Tageslimit erreicht (${cfg.perDay} Freigaben über MCP pro Tag)`)
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, input.draftId), eq(schema.tasks.workspaceId, ws.id)))
  if (!row) throw new McpApproveError(404, 'Entwurf nicht gefunden')
  const { draft, task } = row
  if (draft.status !== 'offen') throw new McpApproveError(409, `Entwurf ist ${draft.status}`)
  if (draftStamp(draft) !== input.stand) throw new McpApproveError(409, 'Entwurf wurde seit dem Lesen geändert: neu lesen (entwurf_lesen oder freigaben_liste) und erneut prüfen')
  const project = task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  const review = await reviewForMcp(db, ws, task, draft, project)
  if (!review.allowed) throw new McpApproveError(422, `Nicht freigegeben: ${review.blockers.join('; ')}`)
  const broken = await checkLinks(review.links, fetchImpl)
  if (broken.length) throw new McpApproveError(422, `Nicht freigegeben, Links nicht erreichbar: ${broken.join(', ')}`)

  const [fresh] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
  if (!fresh || fresh.status !== 'offen' || draftStamp(fresh) !== input.stand) throw new McpApproveError(409, 'Entwurf wurde während der Prüfung geändert')
  try {
    await applyDraftAction(db, ws, who.userId, draft.id, 'approve')
  }
  catch (err) {
    if (err instanceof DraftStateError) throw new McpApproveError(409, err.message)
    throw err
  }
  const [t2] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  const earliest = new Date(now().getTime() + cfg.delayMin * 60_000)
  const planned = plannedAt(t2!, ws.timezone)
  let releaseAt = planned.getTime() > earliest.getTime() ? planned : earliest
  const out = goesOut(ws, project, t2!, draft)
  try {
    if (out && draft.kind === 'mail') await scheduleSend(db, ws, { task: t2!, draft: { ...draft, status: 'freigegeben' }, project: project!, mode: 'auto', at: releaseAt })
    else if (out && isArticleTask(t2!, draft)) await scheduleArticle(db, ws, { task: t2!, draft, mode: 'manual', at: releaseAt, userId: who.userId })
    else if (out && repliesItself(t2!)) await db.update(schema.jobs).set({ runAt: releaseAt }).where(and(eq(schema.jobs.dedupeKey, `listening_reply:${draft.id}`), eq(schema.jobs.status, 'queued')))
    else if (out) releaseAt = (await schedulePost(db, ws, { task: t2!, draft: { ...draft, status: 'freigegeben' }, project, mode: 'manual', at: releaseAt, userId: who.userId })).scheduledAt
  }
  catch (err) {
    await revert(db, t2!, draft.id)
    if (err instanceof PublishError || err instanceof MailError) throw new McpApproveError(422, `Nicht freigegeben: ${err.message}`)
    throw err
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.drafts).set({ approvedVia: 'mcp', releaseAt }).where(eq(schema.drafts.id, draft.id))
    await tx.insert(schema.taskNotes).values({ taskId: task.id, userId: who.userId, text: `Von Claude über MCP freigegeben (v${draft.version}${draft.kind === 'mail' ? `, Antwort an ${draft.recipient}` : ''}): ${reason.slice(0, 2000)}`, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'mcp', userId: who.userId, action: 'mcp_approved', detail: { title: task.title, version: draft.version, kind: draft.kind, releaseAt: releaseAt.toISOString(), goesOut: out, reason: reason.slice(0, 300) }, at: now() })
  })
  return { draftId: draft.id, code: task.code, releaseAt: releaseAt.toISOString(), goesOut: out, remainingToday: Math.max(0, cfg.perDay - used - 1) }
}

export async function revert(db: Db, task: Task, draftId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await cancelPosts(tx, task.id)
    await tx.delete(schema.jobs).where(and(eq(schema.jobs.dedupeKey, `publish_article:${draftId}`), ne(schema.jobs.status, 'running')))
    await tx.update(schema.drafts).set({ status: 'offen', approvedAt: null, approvedByUserId: null, approvedVia: null, releaseAt: null }).where(eq(schema.drafts.id, draftId))
    const [cur] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    if (cur?.status === 'freigegeben') await updateTask(tx as unknown as Db, cur, { status: 'entwurf_fertig' }, { type: 'agent' })
  })
}

export async function stopMcpApproval(db: Db, ws: Workspace, userId: string, draftId: string): Promise<{ taskId: string } | null> {
  return stopRelease(db, ws, userId, draftId, true)
}

export async function stopRelease(db: Db, ws: Workspace, userId: string, draftId: string, onlyMcp = false): Promise<{ taskId: string } | null> {
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, draftId), eq(schema.tasks.workspaceId, ws.id)))
  if (!row) return null
  const { draft, task } = row
  const mcp = draft.approvedVia === 'mcp'
  if ((onlyMcp && !mcp) || draft.status !== 'freigegeben' || task.status !== 'freigegeben') throw new McpApproveError(409, onlyMcp ? 'Nicht mehr zu stoppen (schon raus oder nicht von Claude freigegeben)' : 'Nicht mehr zu stoppen (schon raus)')
  const [running] = await db.select({ id: schema.socialPosts.id }).from(schema.socialPosts).where(and(eq(schema.socialPosts.taskId, task.id), eq(schema.socialPosts.status, 'laeuft'))).limit(1)
  if (running) throw new McpApproveError(409, 'Nicht mehr zu stoppen (wird gerade gepostet)')
  await db.transaction(async (tx) => {
    await cancelPosts(tx, task.id)
    await tx.delete(schema.jobs).where(and(inArray(schema.jobs.dedupeKey, [`publish_article:${draft.id}`, `publish_article:${draft.id}:retry`]), ne(schema.jobs.status, 'running')))
    await tx.update(schema.drafts).set({ status: 'offen', approvedAt: null, approvedByUserId: null, approvedVia: null, releaseAt: null }).where(eq(schema.drafts.id, draft.id))
    await updateTask(tx as unknown as Db, task, { status: 'entwurf_fertig' }, { type: 'user', userId })
    await tx.insert(schema.taskNotes).values({ taskId: task.id, userId, text: mcp ? 'Freigabe von Claude gestoppt, Entwurf wieder offen.' : draft.approvedVia === 'reviewer' ? 'Freigabe vom KI-Prüfer gestoppt, Entwurf wieder offen.' : 'Geplante Veröffentlichung gestoppt, Entwurf wieder offen.', createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'user', userId, action: mcp ? 'mcp_approval_stopped' : 'release_stopped', detail: { title: task.title, version: draft.version }, at: now() })
  })
  return { taskId: task.id }
}
