import { and, desc, eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from './db'
import { schema } from './db'

type WithChannel = { projectId: string | null, strategyChannel: string | null }

// Hängt die Orte (places) des Strategie-Kanals an, damit dort genannte Plattformen bei der Plattformwahl mitzählen.
export async function withChannelPlaces<T extends WithChannel>(db: DbOrTx, rows: T[]): Promise<(T & { channelPlaces: string[] | null })[]> {
  const ids = [...new Set(rows.filter(r => r.projectId && r.strategyChannel).map(r => r.projectId!))]
  const byProject = new Map<string, Map<string, string[]>>()
  if (ids.length) {
    const strategies = await db.select({ projectId: schema.strategies.projectId, channels: schema.strategies.channels }).from(schema.strategies)
      .where(and(inArray(schema.strategies.projectId, ids), eq(schema.strategies.status, 'aktiv'))).orderBy(desc(schema.strategies.version))
    for (const s of strategies) {
      if (!s.projectId || byProject.has(s.projectId)) continue
      byProject.set(s.projectId, new Map(s.channels.map(c => [c.key, c.places ?? []])))
    }
  }
  return rows.map(r => ({ ...r, channelPlaces: (r.projectId && r.strategyChannel ? byProject.get(r.projectId)?.get(r.strategyChannel) : null) ?? null }))
}
