import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({ name: z.string().trim().min(1).max(60) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  const input = await parseBody(event, body)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404, statusMessage: 'Passkey nicht gefunden' })
  const db = await getDb()
  const rows = await db.update(schema.passkeys).set({ name: input.name })
    .where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, s.user.id))).returning({ id: schema.passkeys.id })
  if (!rows.length) throw createError({ statusCode: 404, statusMessage: 'Passkey nicht gefunden' })
  return { ok: true }
})
