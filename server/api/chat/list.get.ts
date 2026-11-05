import { listConversations } from '~~/server/lib/chat'
import { getDb } from '~~/server/lib/db'

const query = z.object({ project: z.string().max(60).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  return { chats: await listConversations(db, await chatActor(db, s), project?.id ?? null) }
})
