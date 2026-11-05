import { newConversation } from '~~/server/lib/chat'
import { getDb } from '~~/server/lib/db'

const body = z.object({ project: z.string().max(60).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const project = await resolveProject(db, s, input.project)
  const conv = await newConversation(db, await chatActor(db, s), project?.id ?? null)
  return { id: conv.id }
})
