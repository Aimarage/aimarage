import { createHmac } from 'node:crypto'
import { lt, sql } from 'drizzle-orm'
import { now } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { derivedKey } from './secret'

export function storedKey(prefix: string, key: string): string {
  return `${prefix}:${createHmac('sha256', derivedKey('ratelimit-v1')).update(key).digest('base64url').slice(0, 32)}`
}

function rowsOf<T>(res: unknown): T[] {
  return (res as { rows: T[] }).rows
}

function secondsUntil(resetAt: Date | string, at: Date): number {
  return Math.max(1, Math.ceil((new Date(resetAt).getTime() - at.getTime()) / 1000))
}

export class RateLimiter {
  constructor(readonly prefix: string, readonly max: number, readonly windowMs: number) {}

  async retryAfter(db: DbOrTx, key: string, at = now()): Promise<number> {
    const res = await db.execute(sql`select count, reset_at from rate_limits where key = ${storedKey(this.prefix, key)} and reset_at > ${at.toISOString()}::timestamptz`)
    const row = rowsOf<{ count: number, reset_at: string | Date }>(res)[0]
    if (!row || Number(row.count) < this.max) return 0
    return secondsUntil(row.reset_at, at)
  }

  async fail(db: DbOrTx, key: string, at = now()): Promise<number> {
    const t = at.toISOString()
    const until = new Date(at.getTime() + this.windowMs).toISOString()
    const res = await db.execute(sql`
      insert into rate_limits (key, count, reset_at) values (${storedKey(this.prefix, key)}, 1, ${until}::timestamptz)
      on conflict (key) do update set
        count = case when rate_limits.reset_at <= ${t}::timestamptz then 1 else rate_limits.count + 1 end,
        reset_at = case when rate_limits.reset_at <= ${t}::timestamptz then ${until}::timestamptz else rate_limits.reset_at end
      returning count
    `)
    return Number(rowsOf<{ count: number }>(res)[0]?.count ?? 1)
  }

  async hit(db: DbOrTx, key: string, at = now()): Promise<number> {
    await this.fail(db, key, at)
    return this.retryAfter(db, key, at)
  }

  async reset(db: DbOrTx, key: string): Promise<void> {
    await db.execute(sql`delete from rate_limits where key = ${storedKey(this.prefix, key)}`)
  }
}

export async function pruneRateLimits(db: DbOrTx, at = now()): Promise<void> {
  await db.delete(schema.rateLimits).where(lt(schema.rateLimits.resetAt, at))
}

export const loginLimiter = new RateLimiter('login', 10, 15 * 60_000)
