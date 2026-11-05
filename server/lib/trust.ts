import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { autonomyKindOf, FIXED_APPROVAL, type AutonomyKindT } from '../../shared/utils/plan'
import type { DbOrTx } from './db'
import { schema } from './db'
import { socialTarget } from './publish'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export const TRUST_RUN = 5
export const TRUST_KINDS = ['social', 'content', 'mail'] as const
export type TrustKind = typeof TRUST_KINDS[number]

export function trustOutlets(ws: Workspace, project: Pick<Project, 'setup'>): Record<TrustKind, boolean> {
  return {
    social: !!socialTarget(ws, project)?.platforms.some(p => p.postable),
    content: !!project.setup?.blogApi?.secret,
    mail: !!project.setup?.mail?.smtp?.host,
  }
}

export interface Decision {
  taskId: string
  kind: AutonomyKindT | null
  at: Date
  clean: boolean
}

export function decisions(rows: { taskId: string, category: string, draftKind: string | null, status: string, byAgent: boolean, approvedBy: string | null, approvedAt: Date | null, createdAt: Date }[]): Decision[] {
  const byTask = new Map<string, typeof rows>()
  for (const r of rows) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r])
  const out: Decision[] = []
  for (const [taskId, list] of byTask) {
    const approved = list.filter(r => r.status === 'freigegeben' && r.approvedBy)
    const rejected = list.some(r => r.status === 'verworfen')
    if (!approved.length && !rejected) continue
    const edited = list.some(r => !r.byAgent)
    const at = new Date(Math.max(...list.map(r => (r.approvedAt ?? r.createdAt).getTime())))
    out.push({ taskId, kind: autonomyKindOf(list[0]!.category, list[0]!.draftKind), at, clean: approved.length > 0 && !rejected && !edited && list.length === 1 })
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime())
}

export function suggestKinds(list: Decision[], project: Pick<Project, 'autonomy' | 'setup'>, outlets: Record<TrustKind, boolean>): TrustKind[] {
  const out: TrustKind[] = []
  for (const k of TRUST_KINDS) {
    if (FIXED_APPROVAL.includes(k) || (project.autonomy?.[k] ?? 'approve') !== 'approve' || !outlets[k]) continue
    const since = project.setup?.trustAsked?.[k]
    const recent = list.filter(d => d.kind === k && (!since || d.at.getTime() > new Date(since).getTime())).slice(0, TRUST_RUN)
    if (recent.length === TRUST_RUN && recent.every(d => d.clean)) out.push(k)
  }
  return out
}

export async function trustSuggestions(db: DbOrTx, ws: Workspace, project: Project): Promise<TrustKind[]> {
  const outlets = trustOutlets(ws, project)
  if (!TRUST_KINDS.some(k => outlets[k] && (project.autonomy?.[k] ?? 'approve') === 'approve')) return []
  const rows = await db.select({ taskId: schema.tasks.id, category: schema.tasks.category, draftKind: schema.tasks.draftKind, status: schema.drafts.status, byAgent: schema.drafts.byAgent, approvedBy: sql<string | null>`case when ${schema.drafts.approvedVia} = 'mcp' then null else ${schema.drafts.approvedByUserId} end`, approvedAt: schema.drafts.approvedAt, createdAt: schema.drafts.createdAt })
    .from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.projectId, project.id), inArray(schema.drafts.status, ['freigegeben', 'verworfen', 'ersetzt'])))
    .orderBy(desc(schema.drafts.createdAt)).limit(300)
  return suggestKinds(decisions(rows), project, outlets)
}
