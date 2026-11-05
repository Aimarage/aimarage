import { and, eq } from 'drizzle-orm'
import { isValidIso } from '~~/shared/utils/dates'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({
  projectId: z.string().uuid(),
  key: z.string().trim().min(1).max(40),
  day: z.string().refine(isValidIso),
  value: z.number().finite().min(0),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, input.projectId), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  await assertProjectVisible(db, s, p.id, 'Projekt nicht gefunden')
  await db.insert(schema.metrics).values({ projectId: p.id, key: input.key, day: input.day, value: input.value, source: 'manuell' })
    .onConflictDoUpdate({ target: [schema.metrics.projectId, schema.metrics.key, schema.metrics.day], set: { value: input.value, source: 'manuell' } })
  return { ok: true }
})
