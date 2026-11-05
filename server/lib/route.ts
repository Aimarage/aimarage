import { eq } from 'drizzle-orm'
import { taskType } from '../../shared/utils/drafting'
import type { TaskRoute } from '../../shared/utils/task-state'
import type { DbOrTx } from './db'
import { schema } from './db'
import { decideSend, mailReady } from './mail'
import { canPublishTask, decideArticle, decidePublish } from './outlets'
import { socialTarget, targetAccounts } from './publish'

type TaskRow = typeof schema.tasks.$inferSelect
type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export interface RouteTask {
  title: string
  category: TaskRow['category']
  channel: string | null
  targetUrl?: string | null
  draftKind: string | null
  humanStep: string | null
  assigneeUserId: string | null
  origin?: string | null
}

export function heldForApproval(origin: string | null | undefined): boolean {
  return origin === 'api' || origin === 'rss' || !!origin?.startsWith('evergreen:')
}

export function routeOf(t: RouteTask, project: Pick<Project, 'autonomy' | 'setup'> | null, outlet: boolean): TaskRoute {
  if (taskType(t) === 'research') return 'auto'
  const held = heldForApproval(t.origin)
  if (project && t.draftKind === 'mail') {
    if (!held && decideSend(project, { category: t.category, draftKind: 'mail' }).action === 'send') return 'auto'
    return mailReady(project) ? 'approve' : 'self'
  }
  if (project && outlet && canPublishTask(t)) return !held && decidePublish(project.autonomy ?? {}, t, true).action === 'publish' ? 'auto' : 'approve'
  if (project?.setup?.blogApi?.secret && (t.category === 'content' || t.draftKind === 'article')) return !held && decideArticle(project).action === 'publish' ? 'auto' : 'approve'
  return !t.humanStep && !t.assigneeUserId ? 'auto' : 'self'
}

export async function routeContext(db: DbOrTx, ws: Workspace) {
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))
  const map = new Map(projects.map(p => [p.id, { project: p, target: socialTarget(ws, p) }]))
  return (t: RouteTask & { projectId: string | null }) => {
    const c = t.projectId ? map.get(t.projectId) : undefined
    const outlet = canPublishTask(t) && targetAccounts(c?.target ?? null, t).length > 0
    return { route: routeOf(t, c?.project ?? null, outlet), outlet }
  }
}
