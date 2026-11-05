import { and, eq, sql } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { removeMedia } from '~~/server/lib/media'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const id = getRouterParam(event, 'id')!
  const mediaId = getRouterParam(event, 'mediaId')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, row.task.projectId, 'Entwurf nicht gefunden')
  const m = row.draft.media.find(x => x.id === mediaId)
  if (!m) throw createError({ statusCode: 404, statusMessage: 'Datei nicht gefunden' })
  const media = row.draft.media.filter(x => x.id !== mediaId)
  await db.update(schema.drafts).set({ media }).where(eq(schema.drafts.id, row.draft.id))
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.drafts).where(sql`${schema.drafts.media} @> ${JSON.stringify([{ id: mediaId }])}::jsonb`)
  if (!n) await removeMedia(m)
  return { media: media.map(x => ({ id: x.id, name: x.name, mime: x.mime, size: x.size })) }
})
