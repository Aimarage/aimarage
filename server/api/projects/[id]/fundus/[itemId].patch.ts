import { and, eq } from 'drizzle-orm'
import { schema } from '~~/server/lib/db'
import { fundusView, updateFundusItem } from '~~/server/lib/fundus'

const body = z.object({ description: z.string().max(500).optional(), tags: z.array(z.string().max(40)).max(20).optional(), checked: z.boolean().optional() })

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'member')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'itemId')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [item] = await db.select().from(schema.mediaLibrary).where(and(eq(schema.mediaLibrary.id, id), eq(schema.mediaLibrary.projectId, p.id)))
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Datei nicht gefunden' })
  return { item: fundusView(await updateFundusItem(db, item, input)) }
})
