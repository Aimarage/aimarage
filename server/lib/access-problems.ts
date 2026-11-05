import { and, eq, isNull } from 'drizzle-orm'
import { accessProblems, type AccessProblem } from '../../shared/utils/access'
import { isPlatformBlocked } from '../../shared/utils/blocked-platforms'
import type { SocialConn } from './platforms/types'
import { listConnections } from './connections'
import type { DbOrTx } from './db'
import { schema } from './db'

type Workspace = typeof schema.workspaces.$inferSelect
type AccessProjectRow = { id: string, slug: string, name: string, setup: typeof schema.projects.$inferSelect['setup'] }

// Gestrichene Plattformen melden nie einen Zugangsfehler: Konten fallen aus der Zuordnung, ganz gestrichene ganz weg.
export function withoutBlocked(projects: AccessProjectRow[], conns: SocialConn[]): { projects: AccessProjectRow[], conns: SocialConn[] } {
  const byId = new Map(conns.map(c => [c.id, c]))
  const kept = projects.map((p) => {
    const ids = p.setup?.social?.accountIds
    if (!ids?.length) return p
    const left = ids.filter(id => !isPlatformBlocked(p, byId.get(id)?.platform))
    return left.length === ids.length ? p : { ...p, setup: { ...p.setup, social: { ...p.setup.social, accountIds: left } } }
  })
  const list = conns.filter((c) => {
    const owners = projects.filter(p => p.setup?.social?.accountIds?.includes(c.id))
    const pool = owners.length ? owners : projects
    return !pool.length || !pool.every(p => isPlatformBlocked(p, c.platform))
  })
  return { projects: kept, conns: list }
}

// Zugangsfehler des Arbeitsbereichs (nur aktive Projekte, optional auf Projekt-Ids beschränkt).
export async function workspaceAccessProblems(db: DbOrTx, ws: Workspace, opts: { projectIds?: string[] | null, locale?: 'de' | 'en' } = {}): Promise<AccessProblem[]> {
  const rows = await db.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name, setup: schema.projects.setup }).from(schema.projects)
    .where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))
  const { projects, conns } = withoutBlocked(rows, listConnections(ws))
  const list = accessProblems(projects, conns, ws.settings?.ownLlm?.error ?? null, opts.locale ?? 'de')
  const ids = opts.projectIds
  return ids ? list.filter(a => !a.projectId || ids.includes(a.projectId)) : list
}
