import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import type { ClientVerdict } from '../db/schema'
import { logActivity } from '../lib/activity'
import { cleanLabel, hashSecret, newSecret } from '../lib/api/tokens'
import { now } from '../lib/clock'
import type { Db, DbOrTx } from '../lib/db'
import { schema } from '../lib/db'
import { MEDIA_TYPES } from '../lib/media'
import { mediaLink } from '../lib/media-link'
import { workspaceBrand } from '../lib/extensions'
import { RateLimiter } from '../lib/ratelimit'
import { projectOwner } from '../lib/strategy'
import { deliverSystemMail } from '../lib/system-mail'
import { renderSystemMail } from '../mail-templates'
import { approveAndSchedule } from './approve'
import { DraftStateError } from './drafts'
import { isLimitError } from '../lib/limits'
import { buildWeeklyReport, renderReportHtml } from './report'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type ClientLink = typeof schema.clientLinks.$inferSelect

export const CLIENT_TOKEN_PREFIX = 'akl_'
export const MAX_CLIENT_LINKS = 10
export const clientBadTokens = new RateLimiter('client-bad-token', 20, 15 * 60_000)
export const clientHits = new RateLimiter('client-hits', 300, 10 * 60_000)
export const clientActions = new RateLimiter('client-actions', 60, 60 * 60_000)
export const clientLinkMails = new RateLimiter('client-link-mail', 30, 86_400_000)

export class ClientLinkError extends Error {}

export function clientTokenShape(token: string): boolean {
  return /^akl_[\w-]{40,60}$/.test(token)
}

export async function createClientLink(db: DbOrTx, input: { workspaceId: string, projectId: string, userId: string | null, label?: string | null, days?: number | null, canReport?: boolean }): Promise<{ id: string, token: string }> {
  const active = await db.select({ id: schema.clientLinks.id }).from(schema.clientLinks).where(and(eq(schema.clientLinks.projectId, input.projectId), isNull(schema.clientLinks.revokedAt)))
  if (active.length >= MAX_CLIENT_LINKS) throw new ClientLinkError(`Höchstens ${MAX_CLIENT_LINKS} aktive Kunden-Links je Projekt`)
  const token = newSecret(CLIENT_TOKEN_PREFIX)
  const [row] = await db.insert(schema.clientLinks).values({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    label: cleanLabel(input.label, 'Kunde'),
    hint: token.slice(-4),
    tokenHash: hashSecret(token),
    canReport: !!input.canReport,
    createdByUserId: input.userId,
    createdAt: now(),
    expiresAt: input.days ? new Date(now().getTime() + input.days * 86_400_000) : null,
  }).returning({ id: schema.clientLinks.id })
  return { id: row!.id, token }
}

export async function revokeClientLink(db: DbOrTx, projectId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false
  const rows = await db.update(schema.clientLinks).set({ revokedAt: now() })
    .where(and(eq(schema.clientLinks.id, id), eq(schema.clientLinks.projectId, projectId), isNull(schema.clientLinks.revokedAt)))
    .returning({ id: schema.clientLinks.id })
  return rows.length > 0
}

export async function listClientLinks(db: DbOrTx, projectId: string) {
  const rows = await db.select().from(schema.clientLinks).where(and(eq(schema.clientLinks.projectId, projectId), isNull(schema.clientLinks.revokedAt))).orderBy(desc(schema.clientLinks.createdAt))
  const t = now().getTime()
  return rows.map(r => ({ id: r.id, label: r.label, hint: r.hint, canReport: r.canReport, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt?.toISOString() ?? null, expired: !!r.expiresAt && r.expiresAt.getTime() <= t, lastUsedAt: r.lastUsedAt?.toISOString() ?? null }))
}

export interface ResolvedClient {
  link: ClientLink
  project: Project
  ws: Workspace
}

export async function resolveClientLink(db: Db, token: string): Promise<ResolvedClient | null> {
  if (!clientTokenShape(token)) return null
  const [row] = await db.select({ link: schema.clientLinks, project: schema.projects, ws: schema.workspaces }).from(schema.clientLinks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.clientLinks.projectId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.clientLinks.workspaceId))
    .where(eq(schema.clientLinks.tokenHash, hashSecret(token)))
  if (!row || row.link.revokedAt || row.project.archivedAt || row.project.workspaceId !== row.link.workspaceId) return null
  if (row.link.expiresAt && row.link.expiresAt.getTime() <= now().getTime()) return null
  if (!row.link.lastUsedAt || now().getTime() - row.link.lastUsedAt.getTime() > 60_000) {
    await db.update(schema.clientLinks).set({ lastUsedAt: now() }).where(eq(schema.clientLinks.id, row.link.id))
  }
  return row
}

export interface ClientDraft {
  id: string
  title: string
  kind: string
  subject: string | null
  body: string
  platforms: { platform: string, text: string }[]
  media: { url: string, kind: 'image' | 'video', name: string }[]
  dueDate: string | null
  dueTime: string | null
  targetUrl: string | null
  feedback: { verdict: ClientVerdict, comment: string | null, at: string } | null
}

export async function clientDrafts(db: DbOrTx, c: Pick<ResolvedClient, 'project'>, base: string): Promise<ClientDraft[]> {
  const rows = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.projectId, c.project.id), eq(schema.tasks.workspaceId, c.project.workspaceId), eq(schema.drafts.status, 'offen'), ne(schema.drafts.kind, 'mail')))
    .orderBy(schema.tasks.dueDate, schema.tasks.dueTime, desc(schema.drafts.createdAt))
  const fb = await latestFeedback(db, rows.map(r => r.draft.id))
  return rows.map(({ draft, task }) => ({
    id: draft.id,
    title: task.title,
    kind: draft.kind,
    subject: draft.subject,
    body: draft.body,
    platforms: draft.platforms.filter(p => draft.variants[p]?.trim()).map(p => ({ platform: p, text: draft.variants[p]! })),
    media: draft.media.filter(m => MEDIA_TYPES[m.mime]).map(m => ({ url: mediaLink(m, base), kind: MEDIA_TYPES[m.mime]!.kind, name: m.name })),
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    targetUrl: draft.targetUrl ?? task.targetUrl,
    feedback: fb.get(draft.id) ?? null,
  }))
}

export async function latestFeedback(db: DbOrTx, draftIds: string[]): Promise<Map<string, { verdict: ClientVerdict, comment: string | null, at: string }>> {
  const out = new Map<string, { verdict: ClientVerdict, comment: string | null, at: string }>()
  if (!draftIds.length) return out
  const rows = await db.select().from(schema.clientFeedback).where(inArray(schema.clientFeedback.draftId, draftIds)).orderBy(desc(schema.clientFeedback.createdAt))
  for (const r of rows) if (!out.has(r.draftId)) out.set(r.draftId, { verdict: r.verdict, comment: r.comment, at: r.createdAt.toISOString() })
  return out
}

async function approver(db: DbOrTx, project: Project): Promise<string | null> {
  const owner = await projectOwner(db, project.id)
  if (owner) return owner
  const [m] = await db.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, project.workspaceId), eq(schema.memberships.role, 'owner'))).orderBy(schema.memberships.createdAt).limit(1)
  return m?.u ?? null
}

const dash = (s: string) => s.replace(/[\u2013\u2014]/g, '-')

export async function clientRespond(db: Db, c: ResolvedClient, input: { draftId: string, verdict: ClientVerdict, comment?: string | null }): Promise<{ approved: boolean, note: string | null }> {
  if (!/^[0-9a-f-]{36}$/i.test(input.draftId)) throw new ClientLinkError('Entwurf nicht gefunden')
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, input.draftId), eq(schema.tasks.projectId, c.project.id), eq(schema.tasks.workspaceId, c.project.workspaceId), ne(schema.drafts.kind, 'mail')))
  if (!row) throw new ClientLinkError('Entwurf nicht gefunden')
  if (row.draft.status !== 'offen') throw new ClientLinkError('Dieser Entwurf ist nicht mehr offen')
  const comment = input.comment ? dash(input.comment.replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, ' ').trim()).slice(0, 2000) : ''
  if (input.verdict === 'change' && !comment) throw new ClientLinkError('Bitte kurz beschreiben, was geändert werden soll')
  const who = `Kunde (${c.link.label})`
  const text = input.verdict === 'ok'
    ? `${who}: passt${comment ? ` - ${comment}` : ''} (Entwurf v${row.draft.version})`
    : `${who} wünscht Änderung an Entwurf v${row.draft.version}: ${comment}`
  await db.transaction(async (tx) => {
    await tx.insert(schema.taskNotes).values({ taskId: row.task.id, userId: null, byAgent: false, text, createdAt: now() })
    await tx.insert(schema.clientFeedback).values({ workspaceId: c.ws.id, projectId: c.project.id, linkId: c.link.id, taskId: row.task.id, draftId: row.draft.id, verdict: input.verdict, comment: comment || null, createdAt: now() })
    await logActivity(tx, { workspaceId: c.ws.id, projectId: c.project.id, taskId: row.task.id, actor: 'system', action: input.verdict === 'ok' ? 'client_ok' : 'client_change', detail: { title: row.task.title, client: c.link.label, comment: comment.slice(0, 300) || null }, at: now() })
  })
  if (input.verdict !== 'ok' || !c.project.setup?.client?.okApproves) return { approved: false, note: null }
  const userId = await approver(db, c.project)
  if (!userId) return { approved: false, note: null }
  try {
    const res = await approveAndSchedule(db, c.ws, userId, row.draft.id, { via: 'kunde' })
    if (!res) return { approved: false, note: null }
    await db.update(schema.clientFeedback).set({ approved: true }).where(and(eq(schema.clientFeedback.draftId, row.draft.id), eq(schema.clientFeedback.verdict, 'ok')))
    await db.insert(schema.taskNotes).values({ taskId: row.task.id, byAgent: false, text: `Kunden-OK gilt als Freigabe: Entwurf v${row.draft.version} freigegeben.${res.warning ? ` ${res.warning}` : ''}`, createdAt: now() })
    await logActivity(db, { workspaceId: c.ws.id, projectId: c.project.id, taskId: row.task.id, actor: 'system', action: 'client_approved', detail: { title: row.task.title, client: c.link.label }, at: now() })
    return { approved: true, note: res.warning ?? null }
  }
  catch (err) {
    if (isLimitError(err)) {
      await db.insert(schema.taskNotes).values({ taskId: row.task.id, byAgent: false, text: `Kunden-OK nicht als Freigabe übernommen: ${err.message}`, createdAt: now() })
      return { approved: false, note: 'Danke, dein OK ist angekommen. Veröffentlicht wird nach einer kurzen Prüfung.' }
    }
    if (!(err instanceof DraftStateError)) throw err
    await db.insert(schema.taskNotes).values({ taskId: row.task.id, byAgent: false, text: `Kunden-OK nicht als Freigabe übernommen: ${err.message}`, createdAt: now() })
    return { approved: false, note: err.message }
  }
}

export async function clientFeedbackList(db: DbOrTx, projectId: string, limit = 30) {
  const rows = await db.select({ f: schema.clientFeedback, code: schema.tasks.code, title: schema.tasks.title, label: schema.clientLinks.label })
    .from(schema.clientFeedback)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.clientFeedback.taskId))
    .leftJoin(schema.clientLinks, eq(schema.clientLinks.id, schema.clientFeedback.linkId))
    .where(eq(schema.clientFeedback.projectId, projectId))
    .orderBy(desc(schema.clientFeedback.createdAt)).limit(limit)
  return rows.map(r => ({ id: r.f.id, taskId: r.f.taskId, draftId: r.f.draftId, code: r.code, title: r.title, client: r.label, verdict: r.f.verdict, comment: r.f.comment, approved: r.f.approved, createdAt: r.f.createdAt.toISOString() }))
}

export function clientLang(project: Pick<Project, 'languages'>): 'de' | 'en' {
  return project.languages?.[0] === 'en' ? 'en' : 'de'
}

export async function clientReportPage(db: Db, token: string): Promise<{ status: 200 | 404, html: string | null }> {
  const c = await resolveClientLink(db, token)
  if (!c || !c.link.canReport) return { status: 404, html: null }
  const brand = await workspaceBrand(db, c.ws.id)
  return { status: 200, html: renderReportHtml(await buildWeeklyReport(db, c.ws, c.project), clientLang(c.project), brand ? { brand: brand.name } : {}) }
}

// Link per Mail an den Kunden. Mit eigener Marke: Absendername und Antwortadresse der Agentur, keine Aimarage-Fußzeile.
export async function sendClientLinkMail(db: Db, input: { ws: Pick<Workspace, 'id' | 'name'>, project: Pick<Project, 'name' | 'languages'>, to: string, url: string, sender: { name: string, email: string }, expiresAt: Date | null }): Promise<void> {
  const brand = await workspaceBrand(db, input.ws.id)
  const lang = clientLang(input.project)
  const expires = input.expiresAt ? new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'de-AT', { day: 'numeric', month: 'long', year: 'numeric' }).format(input.expiresAt) : null
  const sender = brand?.name || input.ws.name || input.sender.name
  const mail = renderSystemMail('client-link', { sender, project: input.project.name, url: input.url, expires }, lang, brand ? { name: brand.name } : null)
  await deliverSystemMail(input.to, 'client-link', mail, { fromName: brand ? brand.name : null, replyTo: brand?.replyTo || input.sender.email })
}
