import { MAIL_CATEGORIES } from '~~/shared/utils/inbox'
import { getDb } from '~~/server/lib/db'
import { correctMail, InboxError, markMailDone } from '~~/server/lib/mail'

const body = z.union([z.object({ category: z.enum(MAIL_CATEGORIES) }), z.object({ done: z.boolean() })])

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const input = await parseBody(event, body)
  const db = await getDb()
  try {
    if ('done' in input) return { taskId: null, ...(await markMailDone(db, s.workspace, id, input.done, s.user.id)) }
    return await correctMail(db, s.workspace, id, input.category, s.user.id)
  }
  catch (err) {
    if (err instanceof InboxError) throw createError({ statusCode: 404, statusMessage: err.message })
    throw err
  }
})
