import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { setMail } from '~~/server/lib/mail'

const body = z.object({ markSeen: z.boolean() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p?.setup?.mail) throw createError({ statusCode: 404, statusMessage: 'Kein Postfach eingetragen' })
  await setMail(db, p, { markSeen: input.markSeen })
  return { ok: true, markSeen: input.markSeen }
})
