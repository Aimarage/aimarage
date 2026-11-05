import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { readMedia } from '~~/server/lib/media'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const draftId = getRouterParam(event, 'draftId')!
  const mediaId = getRouterParam(event, 'mediaId')!
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, draftId), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row) throw createError({ statusCode: 404 })
  await assertProjectVisible(db, s, row.task.projectId, 'Datei nicht gefunden')
  const m = row.draft.media.find(x => x.id === mediaId)
  if (!m) throw createError({ statusCode: 404 })
  const data = await readMedia(m).catch(() => null)
  if (!data) throw createError({ statusCode: 404, statusMessage: 'Datei fehlt' })
  setHeader(event, 'Content-Type', m.mime)
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return data
})
