import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DbOrTx } from './db'
import { schema } from './db'
import { createError } from 'h3'
import { pausedLimit } from './limits'
import { RateLimiter } from './ratelimit'

// Vorschau für pausierte Workspaces: einmal ein Projekt mit Analyse und Strategie-Teaser.
// Danach zeigt die App nur den Teaser, die volle Strategie gibt es erst mit laufendem Tarif.

type Ws = { pausedAt: Date | string | null, previewUsedAt?: Date | string | null }

export const PREVIEW_JOB = 'onboard_project'
export const TEASER_CHANNELS = 3
export const TEASER_POSTS = 2

export interface PreviewPost {
  channel: string
  text: string
}

export interface PreviewTeaser {
  summary: string
  positioning: string | null
  channels: { name: string, why: string }[]
  posts: PreviewPost[]
}

// Höchstens eine Vorschau je E-Mail-Adresse (auch über Workspaces hinweg) und 3 je IP und Tag.
// Schlüssel liegen als HMAC in rate_limits.
export const previewMailLimiter = new RateLimiter('preview-mail', 1, 100 * 365 * 86_400_000)
export const previewIpLimiter = new RateLimiter('preview-ip', 3, 86_400_000)

type PreviewWs = { id: string, pausedAt: Date | string | null, previewUsedAt: Date | string | null, deletedAt: Date | string | null }

async function projectCount(db: DbOrTx, workspaceId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.projects).where(eq(schema.projects.workspaceId, workspaceId))
  return r?.n ?? 0
}

// Vorschau nur für einen pausierten Workspace ohne Projekte, der sie noch nicht genutzt hat.
export async function previewAvailable(db: DbOrTx, ws: PreviewWs): Promise<boolean> {
  if (!ws.pausedAt || ws.previewUsedAt || ws.deletedAt) return false
  return (await projectCount(db, ws.id)) === 0
}

// Prüft und verbucht die Vorschau (Workspace-Flag, E-Mail, IP). Wirft 402 'trial' oder 429.
export async function startPreview(db: DbOrTx, ws: PreviewWs, email: string, ip: string): Promise<void> {
  if (!(await previewAvailable(db, ws))) throw pausedLimit('projects')
  const mail = email.trim().toLowerCase()
  if (await previewMailLimiter.retryAfter(db, mail)) throw pausedLimit('projects', 'Für diese E-Mail-Adresse gab es schon eine Vorschau')
  const wait = await previewIpLimiter.retryAfter(db, ip)
  if (wait) throw createError({ statusCode: 429, statusMessage: 'Zu viele Vorschauen von dieser Adresse, bitte morgen erneut', data: { retryAfter: wait } })
  if (!(await claimPreview(db, ws.id))) throw pausedLimit('projects')
  await previewMailLimiter.fail(db, mail)
  await previewIpLimiter.fail(db, ip)
}

export function previewOnly(ws: Ws): boolean {
  return !!ws.pausedAt && !!ws.previewUsedAt
}

export function assertFullAccess(ws: Ws): void {
  if (previewOnly(ws)) throw pausedLimit('projects')
}

// Setzt previewUsedAt genau einmal; false, wenn die Vorschau schon verbraucht ist.
export async function claimPreview(db: DbOrTx, workspaceId: string): Promise<boolean> {
  const rows = await db.update(schema.workspaces).set({ previewUsedAt: sql`now()` })
    .where(and(eq(schema.workspaces.id, workspaceId), isNull(schema.workspaces.previewUsedAt)))
    .returning({ id: schema.workspaces.id })
  return rows.length > 0
}

export async function releasePreview(db: DbOrTx, workspaceId: string): Promise<void> {
  await db.update(schema.workspaces).set({ previewUsedAt: null }).where(eq(schema.workspaces.id, workspaceId))
}

export function teaserFrom(input: { summary: string, positioning?: string | null, channels: { name: string, why: string, weight?: number }[], posts?: PreviewPost[] | null }): PreviewTeaser {
  const channels = [...input.channels].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, TEASER_CHANNELS).map(c => ({ name: c.name, why: c.why }))
  return { summary: input.summary, positioning: input.positioning ?? null, channels, posts: (input.posts ?? []).slice(0, TEASER_POSTS) }
}
