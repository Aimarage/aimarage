import { eq } from 'drizzle-orm'
import { today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { undoAuto } from '~~/server/lib/auto-strategy'
import { assertFullAccess } from '~~/server/lib/preview'

const body = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  assertFullAccess(s.workspace)
  const input = await parseBody(event, body)
  const db = await getDb()
  const [a] = await db.select({ projectId: schema.activity.projectId, workspaceId: schema.activity.workspaceId }).from(schema.activity).where(eq(schema.activity.id, input.id))
  if (!a?.projectId || a.workspaceId !== s.workspace.id) throw createError({ statusCode: 404, statusMessage: 'Anpassung nicht gefunden' })
  await assertProjectVisible(db, s, a.projectId, 'Anpassung nicht gefunden')
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, a.projectId))
  const r = await undoAuto(db, project!, input.id, s.user.id, today(s.workspace.timezone))
  if (!r.ok) throw createError({ statusCode: r.reason === 'done' ? 409 : 404, statusMessage: r.reason === 'done' ? 'Schon rückgängig gemacht' : 'Anpassung nicht gefunden' })
  return { ok: true }
})
