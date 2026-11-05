import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import type { Role } from '../../shared/utils/domain'
import { getDb, schema } from '../lib/db'
import { canSeeProject } from '../lib/access'

export async function projectById(event: H3Event, min: Role = 'viewer') {
  const s = await requireAuth(event, min)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p || !canSeeProject(await accessOf(db, s), p.id)) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  return { s, db, p }
}
