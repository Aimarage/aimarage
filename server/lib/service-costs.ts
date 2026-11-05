import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { config } from './config'
import { now as clockNow } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { numLimit } from './limits'
import { notifyLimit } from './limit-notice'
import { USD_EUR } from './llm'
import type { BraveUse } from './platforms/brave'
import { X_PRICE, xPostUnits } from './platforms/x'

// Fremdkosten gehosteter Dienste je Workspace: Brave über den Betreiber-Schlüssel (je Aufruf), Zernio (je verbundenem
// Konto und Tag) und X über Zernio (je Post, mit Link teurer; X API pass-through). Eigenes Budget limits.servicesEurMonth,
// getrennt vom KI-Budget: ist es aufgebraucht, ruhen die Websuche und X-Posts über Zernio; andere Plattformen posten weiter
// (die Zahl der Konten ist über limits.socialAccounts begrenzt). Eigene Schlüssel zählen nicht.

type Workspace = typeof schema.workspaces.$inferSelect

const BRAVE_USD_PER_CALL = 5 / 1000
export const X_SERVICE = { post: 'x_post', postWithLink: 'x_post_link' } as const
const dayOf = (d: Date) => d.toISOString().slice(0, 10)

export interface ServiceCosts {
  braveCalls: number
  braveEur: number
  zernioAccountDays: number
  zernioEur: number
  xPosts: number
  xLinkPosts: number
  xEur: number
  totalEur: number
  limitEur: number | null
}

const round = (n: number) => Math.round(n * 100) / 100

function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

const TTL_MS = 60_000
const cache = new Map<string, { at: number, value: ServiceCosts }>()

export function resetServiceCostCache(): void {
  cache.clear()
}

export async function serviceCostsMonth(db: DbOrTx, ws: Pick<Workspace, 'id' | 'limits' | 'settings'>, now = clockNow(), fresh = false): Promise<ServiceCosts> {
  const hit = cache.get(ws.id)
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value
  const today = dayOf(now)
  const month = `${today.slice(0, 7)}-01`
  const [b] = await db.select({ n: sql<number>`coalesce(sum(${schema.braveUsage.hostedCalls}), 0)::int` }).from(schema.braveUsage)
    .where(and(eq(schema.braveUsage.workspaceId, ws.id), gte(schema.braveUsage.day, month)))
  const rows = await db.select({ day: schema.serviceUsage.day, units: schema.serviceUsage.units }).from(schema.serviceUsage)
    .where(and(eq(schema.serviceUsage.workspaceId, ws.id), eq(schema.serviceUsage.service, 'zernio'), gte(schema.serviceUsage.day, month)))
  const xRows = await db.select({ service: schema.serviceUsage.service, n: sql<number>`coalesce(sum(${schema.serviceUsage.units}), 0)::int` }).from(schema.serviceUsage)
    .where(and(eq(schema.serviceUsage.workspaceId, ws.id), inArray(schema.serviceUsage.service, [X_SERVICE.post, X_SERVICE.postWithLink]), gte(schema.serviceUsage.day, month)))
    .groupBy(schema.serviceUsage.service)
  const xPosts = Number(xRows.find(r => r.service === X_SERVICE.post)?.n ?? 0)
  const xLinkPosts = Number(xRows.find(r => r.service === X_SERVICE.postWithLink)?.n ?? 0)
  const xEur = (xPosts * X_PRICE.post + xLinkPosts * X_PRICE.postWithLink) * USD_EUR
  let accountDays = rows.reduce((n, r) => n + r.units, 0)
  if (!rows.some(r => String(r.day) === today)) {
    const pid = ws.settings?.social?.hosted?.profileId
    accountDays += pid ? (ws.settings?.social?.accounts ?? []).filter(a => a.profileId === pid).length : 0
  }
  const braveCalls = b?.n ?? 0
  const braveEur = braveCalls * BRAVE_USD_PER_CALL * USD_EUR
  const zernioEur = accountDays * (config.zernioUsdPerAccount / daysInMonth(now)) * USD_EUR
  const value = { braveCalls, braveEur: round(braveEur), zernioAccountDays: accountDays, zernioEur: round(zernioEur), xPosts, xLinkPosts, xEur: round(xEur), totalEur: round(braveEur + zernioEur + xEur), limitEur: numLimit(ws, 'servicesEurMonth') }
  cache.set(ws.id, { at: Date.now(), value })
  return value
}

// Vor jedem Brave-Aufruf über den Betreiber-Schlüssel: null = erlaubt, sonst der Grund, warum die Suche ruht.
// Tagesgrenze braveCallsPerDay ist ein Pool je Arbeitsbereich (alle Projekte zusammen).
export async function braveGate(db: Db, use: BraveUse, now = clockNow()): Promise<'day' | 'month' | null> {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, use.ws)).limit(1)
  if (!ws) return 'day'
  const perDay = numLimit(ws, 'braveCallsPerDay')
  if (perDay !== null) {
    const [r] = await db.select({ n: sql<number>`coalesce(sum(${schema.braveUsage.hostedCalls}), 0)::int` }).from(schema.braveUsage)
      .where(and(eq(schema.braveUsage.workspaceId, ws.id), eq(schema.braveUsage.day, dayOf(now))))
    if ((r?.n ?? 0) >= perDay) return 'day'
  }
  const budget = numLimit(ws, 'servicesEurMonth')
  if (budget !== null) {
    const costs = await serviceCostsMonth(db, ws, now)
    if (costs.totalEur >= budget) {
      await notifyLimit(db, ws, 'servicesEurMonth')
      return 'month'
    }
  }
  return null
}

// Kosten eines X-Posts in EUR (Thread-Teile einzeln, jeder Teil mit Link zum höheren Preis).
export function xPostEur(parts: string[]): number {
  const u = xPostUnits(parts)
  return (u.posts * X_PRICE.post + u.linkPosts * X_PRICE.postWithLink) * USD_EUR
}

// Nach erfolgreichem X-Post über gehostetes Zernio: Teile ohne und mit Link für heute zählen.
export async function recordXPost(db: DbOrTx, workspaceId: string, parts: string[], now = clockNow()): Promise<void> {
  const u = xPostUnits(parts)
  const day = dayOf(now)
  for (const [service, units] of [[X_SERVICE.post, u.posts], [X_SERVICE.postWithLink, u.linkPosts]] as const) {
    if (!units) continue
    await db.insert(schema.serviceUsage).values({ workspaceId, day, service, units })
      .onConflictDoUpdate({ target: [schema.serviceUsage.workspaceId, schema.serviceUsage.day, schema.serviceUsage.service], set: { units: sql`${schema.serviceUsage.units} + ${units}` } })
  }
  cache.delete(workspaceId)
}

// Vor einem X-Post über gehostetes Zernio: null = Budget reicht (oder kein Budget gesetzt), sonst Stand und Bedarf.
export async function xBudgetShort(db: DbOrTx, ws: Pick<Workspace, 'id' | 'limits' | 'settings' | 'timezone'>, parts: string[], now = clockNow()): Promise<{ needEur: number, leftEur: number } | null> {
  const budget = numLimit(ws, 'servicesEurMonth')
  if (budget === null) return null
  const needEur = xPostEur(parts)
  const costs = await serviceCostsMonth(db, ws, now, true)
  const leftEur = Math.max(0, budget - costs.totalEur)
  if (needEur <= leftEur) return null
  await notifyLimit(db, ws, 'servicesEurMonth')
  return { needEur: round(needEur), leftEur: round(leftEur) }
}
