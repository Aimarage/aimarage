import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { attachFundusItem } from '~~/server/lib/fundus'
import { MediaError } from '~~/server/lib/media'

const body = z.object({ itemId: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row || !row.task.projectId) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, row.task.projectId, 'Entwurf nicht gefunden')
  if (row.draft.status !== 'offen' && row.draft.status !== 'freigegeben') throw createError({ statusCode: 409, statusMessage: 'Entwurf ist nicht mehr offen' })
  const [item] = await db.select().from(schema.mediaLibrary).where(and(eq(schema.mediaLibrary.id, input.itemId), eq(schema.mediaLibrary.projectId, row.task.projectId)))
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Datei nicht im Fundus' })
  try {
    const media = await attachFundusItem(db, s.workspace, row.draft, item)
    return { media: media.map(m => ({ id: m.id, name: m.name, mime: m.mime, size: m.size })) }
  }
  catch (err) {
    if (err instanceof MediaError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
