import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404, statusMessage: 'Passkey nicht gefunden' })
  const db = await getDb()
  const [own] = await db.select({ id: schema.passkeys.id }).from(schema.passkeys).where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, s.user.id)))
  if (!own) throw createError({ statusCode: 404, statusMessage: 'Passkey nicht gefunden' })
  requireStepUp(s)
  await db.delete(schema.passkeys).where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, s.user.id)))
  return { ok: true }
})
