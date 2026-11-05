import { revokeClientLink } from '~~/server/services/client'

const query = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'admin')
  const q = parseQuery(event, query)
  if (!(await revokeClientLink(db, p.id, q.id))) throw createError({ statusCode: 404, statusMessage: 'Link nicht gefunden' })
  return { ok: true }
})
