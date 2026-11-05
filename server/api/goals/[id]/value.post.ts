import { and, eq } from 'drizzle-orm'
import { isValidIso } from '~~/shared/utils/dates'
import { today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({ value: z.number().finite().min(0), day: z.string().refine(isValidIso).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [g] = await db.select().from(schema.goals).where(and(eq(schema.goals.id, id), eq(schema.goals.workspaceId, s.workspace.id)))
  if (!g || !g.projectId || !g.metricKey) throw createError({ statusCode: 404, statusMessage: 'Ziel nicht gefunden' })
  await assertProjectVisible(db, s, g.projectId, 'Ziel nicht gefunden')
  const day = input.day ?? today(s.workspace.timezone)
  await db.insert(schema.metrics).values({ projectId: g.projectId, key: g.metricKey, day, value: input.value, source: 'manuell' })
    .onConflictDoUpdate({ target: [schema.metrics.projectId, schema.metrics.key, schema.metrics.day], set: { value: input.value, source: 'manuell' } })
  return { ok: true }
})
