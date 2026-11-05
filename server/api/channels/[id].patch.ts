import { and, eq } from 'drizzle-orm'
import { CHANNEL_STATUSES } from '~~/shared/utils/domain'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({
  status: z.enum(CHANNEL_STATUSES).optional(),
  url: httpUrl(500).nullable().optional().or(z.literal('').transform(() => null)),
  notes: z.string().max(2000).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [ch] = await db.select({ projectId: schema.channels.projectId }).from(schema.channels).where(and(eq(schema.channels.id, id), eq(schema.channels.workspaceId, s.workspace.id)))
  if (!ch) throw createError({ statusCode: 404 })
  await assertProjectVisible(db, s, ch.projectId, 'Kanal nicht gefunden')
  const rows = await db.update(schema.channels).set(input).where(and(eq(schema.channels.id, id), eq(schema.channels.workspaceId, s.workspace.id))).returning({ id: schema.channels.id })
  if (!rows.length) throw createError({ statusCode: 404 })
  return { ok: true }
})
