import { and, eq, gte, sql } from 'drizzle-orm'
import { now as clockNow } from './clock'
import { schema, type Db } from './db'
import { setBraveGate, setBraveRecorder, type BraveUse } from './platforms/brave'
import { braveGate } from './service-costs'

export { BRAVE_PURPOSES, type BravePurpose } from './platforms/brave'

// Brave Search API, Plan "Search": 5 USD je 1000 Anfragen, 5 USD Gratis-Guthaben je Monat (Stand 10/2026).
export const BRAVE_USD_PER_1000 = 5
export const BRAVE_FREE_USD_PER_MONTH = 5

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

export async function recordBrave(db: Db, use: BraveUse, at = clockNow(), hosted = false): Promise<void> {
  const h = hosted ? 1 : 0
  await db.insert(schema.braveUsage).values({ workspaceId: use.ws, projectId: use.project ?? '', day: dayOf(at), purpose: use.purpose, calls: 1, hostedCalls: h })
    .onConflictDoUpdate({ target: [schema.braveUsage.workspaceId, schema.braveUsage.day, schema.braveUsage.purpose, schema.braveUsage.projectId], set: { calls: sql`${schema.braveUsage.calls} + 1`, hostedCalls: sql`${schema.braveUsage.hostedCalls} + ${h}` } })
}

export async function recordBraveBlocked(db: Db, use: BraveUse, at = clockNow()): Promise<void> {
  await db.insert(schema.braveUsage).values({ workspaceId: use.ws, projectId: use.project ?? '', day: dayOf(at), purpose: use.purpose, calls: 0, blocked: 1 })
    .onConflictDoUpdate({ target: [schema.braveUsage.workspaceId, schema.braveUsage.day, schema.braveUsage.purpose, schema.braveUsage.projectId], set: { blocked: sql`${schema.braveUsage.blocked} + 1` } })
}

export function installBraveMeter(db: Db): void {
  setBraveRecorder((use, hosted) => recordBrave(db, use, clockNow(), hosted))
  setBraveGate(async (use) => {
    try {
      const v = await braveGate(db, use)
      if (v) await recordBraveBlocked(db, use)
      return v
    }
    catch (err) {
      console.error('[brave] Grenzprüfung fehlgeschlagen:', (err as Error).message)
      return 'day'
    }
  })
}

export const braveUsd = (calls: number) => Math.round(calls * BRAVE_USD_PER_1000 / 10) / 100

export interface BraveUsage {
  source: 'own' | 'hosted' | null
  perDay: number | null
  blockedToday: number
  today: number
  month: number
  last30: number
  byPurpose: { purpose: string, calls: number }[]
  usdMonth: number
  usdLast30: number
  usdPer1000: number
  freeUsdPerMonth: number
}

export async function braveUsage(db: Db, workspaceId: string, now = clockNow(), extra: { source?: BraveUsage['source'], perDay?: number | null } = {}): Promise<BraveUsage> {
  const today = dayOf(now)
  const month = `${today.slice(0, 7)}-01`
  const from30 = dayOf(new Date(now.getTime() - 29 * 86_400_000))
  const from = from30 < month ? from30 : month
  const rows = await db.select({ day: schema.braveUsage.day, purpose: schema.braveUsage.purpose, calls: schema.braveUsage.calls, blocked: schema.braveUsage.blocked }).from(schema.braveUsage)
    .where(and(eq(schema.braveUsage.workspaceId, workspaceId), gte(schema.braveUsage.day, from)))
  const sum = (f: (d: string) => boolean) => rows.filter(r => f(String(r.day))).reduce((s, r) => s + r.calls, 0)
  const by = new Map<string, number>()
  for (const r of rows) if (String(r.day) >= from30 && r.calls) by.set(r.purpose, (by.get(r.purpose) ?? 0) + r.calls)
  const m = sum(d => d >= month)
  const l = sum(d => d >= from30)
  return {
    source: extra.source ?? null,
    perDay: extra.perDay ?? null,
    blockedToday: rows.filter(r => String(r.day) === today).reduce((n, r) => n + r.blocked, 0),
    today: sum(d => d === today),
    month: m,
    last30: l,
    byPurpose: [...by].map(([purpose, calls]) => ({ purpose, calls })).sort((a, b) => b.calls - a.calls),
    usdMonth: braveUsd(m),
    usdLast30: braveUsd(l),
    usdPer1000: BRAVE_USD_PER_1000,
    freeUsdPerMonth: BRAVE_FREE_USD_PER_MONTH,
  }
}
