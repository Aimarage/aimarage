import { and, eq } from 'drizzle-orm'
import { deleteSession, SESSION_COOKIE } from '~~/server/lib/auth'
import { getDb, schema } from '~~/server/lib/db'

const body = z.object({ workspaceId: z.uuid() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  const db = await getDb()
  const [m] = await db.select({ workspaceId: schema.memberships.workspaceId }).from(schema.memberships)
    .where(and(eq(schema.memberships.userId, s.user.id), eq(schema.memberships.workspaceId, input.workspaceId)))
  if (!m) throw createError({ statusCode: 404, statusMessage: 'Arbeitsbereich nicht gefunden' })
  if (m.workspaceId === s.workspace.id) return { ok: true }
  const old = getCookie(event, SESSION_COOKIE)
  if (old) await deleteSession(db, old)
  await startSession(event, db, s.user.id, m.workspaceId, s.session?.method ?? 'password', s.session?.stepUpAt ?? null)
  deleteCookie(event, 'ma_project', { path: '/' })
  return { ok: true }
})
