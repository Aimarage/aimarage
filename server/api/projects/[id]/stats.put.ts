import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { enqueueJob } from '~~/server/lib/jobs'
import { buildCounterStats, clearCounterCache } from '~~/server/lib/counter'
import { buildStats, copyStatsToken, publicStats, TrafficError } from '~~/server/lib/traffic'

const body = z.object({
  mode: z.enum(['api', 'counter']).optional(),
  url: httpUrl(500).optional(),
  token: z.string().trim().min(8).max(500).optional(),
  campaignPrefix: z.string().trim().max(64).nullable().optional(),
  copyFrom: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  if (input.mode === 'counter') {
    const stats = buildCounterStats(p.setup?.stats)
    await db.update(schema.projects).set({ setup: { ...p.setup, stats } }).where(eq(schema.projects.id, p.id))
    clearCounterCache()
    return { ok: true, stats: publicStats(stats) }
  }
  if (!input.url) throw createError({ statusCode: 400, statusMessage: 'Statistik-Adresse fehlt' })
  try {
    let stats = buildStats(s.workspace.id, p.id, p.setup?.stats, { ...input, url: input.url })
    if (input.copyFrom && !input.token) {
      const [src] = await db.select({ id: schema.projects.id, setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.id, input.copyFrom), eq(schema.projects.workspaceId, s.workspace.id)))
      if (!src || src.id === p.id) throw new TrafficError('Projekt für den Zugang nicht gefunden')
      stats = copyStatsToken(s.workspace.id, { id: src.id, stats: src.setup?.stats }, { id: p.id, stats })
    }
    await db.update(schema.projects).set({ setup: { ...p.setup, stats } }).where(eq(schema.projects.id, p.id))
    clearCounterCache()
    if (stats.secret) await enqueueJob(db, 'utm_sync', { workspaceId: s.workspace.id, payload: { projectId: p.id }, dedupeKey: `utm_sync:${p.id}:save:${Date.now()}`, maxAttempts: 1 })
    return { ok: true, stats: publicStats(stats) }
  }
  catch (err) {
    if (err instanceof TrafficError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
