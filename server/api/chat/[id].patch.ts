import { eq } from 'drizzle-orm'
import { ownConversation } from '~~/server/lib/chat'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({ title: z.string().trim().min(1).max(80) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 404, statusMessage: 'Chat nicht gefunden' })
  const db = await getDb()
  const conv = await ownConversation(db, { workspace: s.workspace, userId: s.user.id }, id.data)
  if (!conv || conv.kind === 'onboarding') throw createError({ statusCode: 404, statusMessage: 'Chat nicht gefunden' })
  const input = await parseBody(event, body)
  await db.update(schema.conversations).set({ title: input.title.replace(/[–—]/g, '-') }).where(eq(schema.conversations.id, conv.id))
  return { ok: true }
})
