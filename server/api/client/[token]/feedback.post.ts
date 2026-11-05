import { getDb } from '~~/server/lib/db'
import { clientActions, ClientLinkError, clientRespond } from '~~/server/services/client'

const body = z.object({
  draftId: z.string().uuid(),
  verdict: z.enum(['ok', 'change']),
  comment: z.string().max(2000).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const c = await clientGate(event)
  const db = await getDb()
  const wait = await clientActions.retryAfter(db, c.link.id)
  if (wait) {
    setResponseHeader(event, 'Retry-After', wait)
    throw createError({ statusCode: 429, statusMessage: 'Zu viele Rückmeldungen, bitte später erneut' })
  }
  const input = await parseBody(event, body)
  await clientActions.fail(db, c.link.id)
  try {
    const r = await clientRespond(db, c, input)
    return { ok: true, approved: r.approved }
  }
  catch (err) {
    if (err instanceof ClientLinkError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
