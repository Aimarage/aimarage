import { eq } from 'drizzle-orm'
import { queueUserMessage, runTurn } from '~~/server/lib/chat'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({ conversationId: z.string().uuid(), text: z.string().trim().min(1).max(8000), page: z.string().max(300).regex(/^\//).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, input.conversationId))
  if (!conv || conv.workspaceId !== s.workspace.id || conv.userId !== s.user.id) throw createError({ statusCode: 404, statusMessage: 'Gespräch nicht gefunden' })
  const actor = { ...(await chatActor(db, s)), page: input.page ?? null }
  const m = await queueUserMessage(db, actor, conv, input.text)
  void runTurn(db, actor, conv.id).catch(err => console.error('[chat]', err))
  return { ok: true, ...m }
})
