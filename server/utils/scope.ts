import { and, eq } from 'drizzle-orm'
import { ALL_SLUG } from '../../shared/utils/domain'
import { canSeeProject, projectAccess, type Access } from '../lib/access'
import type { SessionInfo } from '../lib/auth'
import type { DbOrTx } from '../lib/db'
import { schema } from '../lib/db'

export type ProjectRow = typeof schema.projects.$inferSelect

export function accessOf(db: DbOrTx, s: SessionInfo): Promise<Access> {
  return projectAccess(db, { workspaceId: s.workspace.id, userId: s.user.id, role: s.role }, s)
}

export async function resolveProject(db: DbOrTx, s: SessionInfo, slug: string | undefined | null): Promise<ProjectRow | null> {
  if (!slug || slug === ALL_SLUG) return null
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, s.workspace.id), eq(schema.projects.slug, slug)))
  if (!p || !canSeeProject(await accessOf(db, s), p.id)) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  return p
}

export async function assertProjectVisible(db: DbOrTx, s: SessionInfo, projectId: string | null | undefined, what = 'Aufgabe nicht gefunden'): Promise<void> {
  if (!canSeeProject(await accessOf(db, s), projectId)) throw createError({ statusCode: 404, statusMessage: what })
}

export async function loadTask(db: DbOrTx, s: SessionInfo, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404, statusMessage: 'Aufgabe nicht gefunden' })
  const [t] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, s.workspace.id), eq(schema.tasks.id, id)))
  if (!t) throw createError({ statusCode: 404, statusMessage: 'Aufgabe nicht gefunden' })
  await assertProjectVisible(db, s, t.projectId)
  return t
}

export async function assertMember(db: DbOrTx, workspaceId: string, userId: string | null | undefined): Promise<void> {
  if (!userId) return
  const [m] = await db.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId)))
  if (!m) throw createError({ statusCode: 400, statusMessage: 'Person gehört nicht zum Arbeitsbereich' })
}

// Projekte für einen API-Schlüssel: nur eigene Projekte des Arbeitsbereichs, leer bzw. null = alle sichtbaren.
export async function accessibleProjectIds(db: DbOrTx, s: SessionInfo, ids: string[] | null | undefined): Promise<string[] | null> {
  if (!ids?.length) return null
  const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.workspaceId, s.workspace.id))
  const a = await accessOf(db, s)
  const ok = ids.filter(id => rows.some(r => r.id === id) && canSeeProject(a, id))
  if (ok.length !== ids.length) throw createError({ statusCode: 400, statusMessage: 'Projekt nicht gefunden' })
  return ok
}
