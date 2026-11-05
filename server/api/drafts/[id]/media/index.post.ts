import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { assertStorage } from '~~/server/lib/limits'
import { MAX_MEDIA_PER_DRAFT, MediaError, saveMedia } from '~~/server/lib/media'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, row.task.projectId, 'Entwurf nicht gefunden')
  if (row.draft.status !== 'offen' && row.draft.status !== 'freigegeben') throw createError({ statusCode: 409, statusMessage: 'Entwurf ist nicht mehr offen' })
  const parts = (await readMultipartFormData(event)) ?? []
  const files = parts.filter(p => p.name === 'file' && p.data?.length)
  if (!files.length) throw createError({ statusCode: 400, statusMessage: 'Keine Datei' })
  if (row.draft.media.length + files.length > MAX_MEDIA_PER_DRAFT) throw createError({ statusCode: 400, statusMessage: `Höchstens ${MAX_MEDIA_PER_DRAFT} Dateien` })
  await assertStorage(db, s.workspace, files.reduce((n, f) => n + f.data.length, 0))
  const added = []
  try {
    for (const f of files) added.push(await saveMedia(s.workspace.id, row.draft.id, { name: f.filename ?? 'datei', data: new Uint8Array(f.data) }))
  }
  catch (err) {
    if (err instanceof MediaError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
  const media = [...row.draft.media, ...added]
  await db.update(schema.drafts).set({ media }).where(eq(schema.drafts.id, row.draft.id))
  return { media: media.map(m => ({ id: m.id, name: m.name, mime: m.mime, size: m.size })) }
})
