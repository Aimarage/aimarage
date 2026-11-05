import { and, asc, eq, isNull } from 'drizzle-orm'
import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb, schema } from '~~/server/lib/db'
import { canSeeProject } from '~~/server/lib/access'
import { siteBase } from '~~/server/lib/api/http'
import { listGrants } from '~~/server/lib/api/oauth'
import { listApiTokens, listOtherTokens } from '~~/server/lib/api/tokens'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const base = siteBase()
  const admin = roleAtLeast(s.role, 'admin')
  const a = await accessOf(db, s)
  const projects = (await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(and(eq(schema.projects.workspaceId, s.workspace.id), isNull(schema.projects.archivedAt))).orderBy(asc(schema.projects.sortOrder))).filter(p => canSeeProject(a, p.id))
  return {
    tokens: await listApiTokens(db, s.user.id, s.workspace.id),
    others: admin ? await listOtherTokens(db, s.user.id, s.workspace.id) : [],
    grants: await listGrants(db, s.user.id, s.workspace.id),
    projects,
    mcpUrl: `${base}/mcp`,
    apiUrl: `${base}/api/v1`,
    canWrite: roleAtLeast(s.role, 'member'),
    admin,
  }
})
