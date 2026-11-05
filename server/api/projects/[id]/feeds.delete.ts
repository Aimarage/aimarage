import { removeFeed } from '~~/server/lib/feeds'

const query = z.object({ url: z.string().min(4).max(500) })

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'admin')
  const q = parseQuery(event, query)
  if (!await removeFeed(db, p.id, q.url)) throw createError({ statusCode: 404, statusMessage: 'Feed nicht gefunden' })
  return { ok: true }
})
