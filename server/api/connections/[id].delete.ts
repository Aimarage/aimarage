import { eq } from 'drizzle-orm'
import { logActivity } from '~~/server/lib/activity'
import { getDb, schema } from '~~/server/lib/db'
import { removeConnection } from '~~/server/lib/connections'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!(await removeConnection(db, s.workspace.id, id))) throw createError({ statusCode: 404, statusMessage: 'Verbindung nicht gefunden' })
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, s.workspace.id))
  for (const p of projects) {
    const ids = p.setup?.social?.accountIds ?? []
    if (ids.includes(id)) await db.update(schema.projects).set({ setup: { ...p.setup, social: { ...p.setup.social, accountIds: ids.filter(x => x !== id) } } }).where(eq(schema.projects.id, p.id))
  }
  await logActivity(db, { workspaceId: s.workspace.id, actor: 'user', userId: s.user.id, action: 'connection_removed', detail: {} })
  return { ok: true }
})
