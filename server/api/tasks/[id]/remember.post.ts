import { getDb } from '~~/server/lib/db'
import { rememberFact } from '~~/server/lib/talk'

const body = z.object({ noteId: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  try {
    return { fact: await rememberFact(db, s.workspace, t, input.noteId) }
  }
  catch (err) {
    throw createError({ statusCode: 404, statusMessage: (err as Error).message })
  }
})
