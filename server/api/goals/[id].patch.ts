import { and, eq } from 'drizzle-orm'
import { isValidIso } from '~~/shared/utils/dates'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  targetValue: z.number().finite().min(0).nullable().optional(),
  deadline: z.string().refine(isValidIso).nullable().optional(),
  metricKey: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/).optional(),
  mode: z.enum(['sum', 'last', 'month']).optional(),
  active: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [g] = await db.select().from(schema.goals).where(and(eq(schema.goals.id, id), eq(schema.goals.workspaceId, s.workspace.id)))
  if (!g) throw createError({ statusCode: 404, statusMessage: 'Ziel nicht gefunden' })
  await assertProjectVisible(db, s, g.projectId, 'Ziel nicht gefunden')
  await db.update(schema.goals).set(input).where(eq(schema.goals.id, g.id))
  return { ok: true }
})
