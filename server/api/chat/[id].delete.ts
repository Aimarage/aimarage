import { eq } from 'drizzle-orm'
import { isBusy, ownConversation } from '~~/server/lib/chat'
import { getDb, schema } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 404, statusMessage: 'Chat nicht gefunden' })
  const db = await getDb()
  const conv = await ownConversation(db, { workspace: s.workspace, userId: s.user.id }, id.data)
  if (!conv || conv.kind === 'onboarding') throw createError({ statusCode: 404, statusMessage: 'Chat nicht gefunden' })
  if (isBusy(conv.id)) throw createError({ statusCode: 409, statusMessage: 'Der Agent arbeitet gerade in diesem Chat' })
  await db.delete(schema.conversations).where(eq(schema.conversations.id, conv.id))
  return { ok: true }
})
