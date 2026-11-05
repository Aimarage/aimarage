import { and, desc, eq, inArray } from 'drizzle-orm'
import { taskWhere, type TaskWhere, type WhereTask } from '../../shared/utils/where'
import type { StrategyChannel } from '../db/schema'
import type { DbOrTx } from './db'
import { schema } from './db'
import { mailReady } from './mail'
import { canPublishTask } from './outlets'
import { socialTarget, targetAccounts } from './publish'
import { threadSearch } from './reddit'
import { replyAccount } from './listen-account'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export type WhereSource = WhereTask & { projectId: string | null, strategyChannel?: string | null }

export async function activeChannels(db: DbOrTx, projectIds: string[]): Promise<Map<string, StrategyChannel[]>> {
  const ids = [...new Set(projectIds)]
  if (!ids.length) return new Map()
  const rows = await db.select({ projectId: schema.strategies.projectId, channels: schema.strategies.channels }).from(schema.strategies)
    .where(and(inArray(schema.strategies.projectId, ids), eq(schema.strategies.status, 'aktiv'))).orderBy(desc(schema.strategies.version))
  const map = new Map<string, StrategyChannel[]>()
  for (const r of rows) if (!map.has(r.projectId)) map.set(r.projectId, r.channels)
  return map
}

export function projectPlatforms(ws: Workspace, project: Pick<Project, 'setup'>): string[] {
  return socialTarget(ws, project)?.platforms.map(p => p.platform) ?? []
}

export function whereFor(ws: Workspace, t: WhereSource, project: Project | null, channels: StrategyChannel[], recipient?: string | null): TaskWhere {
  const ch = t.strategyChannel ? channels.find(c => c.key === t.strategyChannel) : undefined
  const target = project ? socialTarget(ws, project) : null
  const autoPost = canPublishTask({ category: t.category, draftKind: t.draftKind ?? null }) && targetAccounts(target, t).length > 0
  const accounts = project ? target?.platforms.map(p => p.platform) ?? [] : undefined
  return taskWhere(t, { blog: project?.setup?.blog ?? null, site: project?.url ?? null, channelName: ch?.name ?? null, places: ch?.places ?? [], recipient, accounts, autoPost, autoMail: mailReady(project), autoBlog: !!project?.setup?.blogApi?.secret, reddit: threadSearch(ws), reply: replyAccount(ws, project, { origin: t.origin ?? null }) })
}

export async function whereLookup(db: DbOrTx, ws: Workspace, projects?: Project[]): Promise<(t: WhereSource) => TaskWhere> {
  const list = projects ?? await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))
  const byId = new Map(list.map(p => [p.id, p]))
  const channels = await activeChannels(db, list.map(p => p.id))
  return t => whereFor(ws, t, t.projectId ? byId.get(t.projectId) ?? null : null, t.projectId ? channels.get(t.projectId) ?? [] : [])
}

export async function taskWhereOf(db: DbOrTx, ws: Workspace, t: WhereSource, project: Project | null, recipient?: string | null): Promise<TaskWhere> {
  const channels = project ? (await activeChannels(db, [project.id])).get(project.id) ?? [] : []
  return whereFor(ws, t, project, channels, recipient)
}
