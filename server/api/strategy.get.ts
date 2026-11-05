import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { CATEGORY_DRAFT } from '~~/shared/utils/plan'
import { effectiveAutonomy, socialOutlet } from '~~/server/lib/outlets'
import { outletReady, socialTarget } from '~~/server/lib/publish'
import { addDays } from '~~/shared/utils/dates'
import { today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { listGoals } from '~~/server/lib/goals'
import { activeStrategy, channelStats, pendingProposal, strategyHistory } from '~~/server/lib/strategy'
import { assertFullAccess } from '~~/server/lib/preview'

const query = z.object({ project: z.string().max(60).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  assertFullAccess(s.workspace)
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  const d = today(s.workspace.timezone)
  const access = await accessOf(db, s)
  const goals = await listGoals(db, s.workspace.id, d, { projectId: project?.id ?? null, access, activeOnly: false })
  if (!project) return { today: d, project: null, goals, active: null, pending: null, history: [], stats: {}, autonomy: {}, lastReview: null, details: {}, rethinking: false }
  const active = await activeStrategy(db, project.id)
  const pending = await pendingProposal(db, project.id)
  const stats = Object.fromEntries(await channelStats(db, project.id, addDays(d, -28), d))
  const history = await strategyHistory(db, project.id)
  const [lastReview] = await db.select({ at: schema.activity.createdAt, detail: schema.activity.detail }).from(schema.activity).where(and(eq(schema.activity.projectId, project.id), eq(schema.activity.action, 'strategy_reviewed'))).orderBy(desc(schema.activity.createdAt)).limit(1)
  const keys = (active?.channels ?? []).map(c => c.key)
  const upcoming = keys.length
    ? await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, date: schema.tasks.dueDate, time: schema.tasks.dueTime, status: schema.tasks.status, channel: schema.tasks.strategyChannel, place: schema.tasks.channel }).from(schema.tasks)
      .where(and(eq(schema.tasks.projectId, project.id), inArray(schema.tasks.strategyChannel, keys), gte(schema.tasks.dueDate, d), sql`${schema.tasks.status} not in ('verworfen', 'erledigt')`))
      .orderBy(asc(schema.tasks.dueDate), asc(schema.tasks.dueTime)).limit(200)
    : []
  const target = outletReady(s.workspace, project) ? socialTarget(s.workspace, project) : null
  const outletLabel = target ? `${socialOutlet(target.cfg.provider)?.label ?? ''} (${target.profile})` : null
  const details = Object.fromEntries((active?.channels ?? []).map((c) => {
    const a = effectiveAutonomy(project.autonomy ?? {}, c.category, CATEGORY_DRAFT[c.category as keyof typeof CATEGORY_DRAFT] ?? null)
    return [c.key, { next: upcoming.filter(u => u.channel === c.key).slice(0, 3), autonomy: a.level, fixed: a.fixed, outlet: c.category === 'social' ? outletLabel : null }]
  }))
  const [running] = await db.select({ id: schema.agentRuns.id }).from(schema.agentRuns).where(and(eq(schema.agentRuns.projectId, project.id), eq(schema.agentRuns.job, 'rethink_strategy'), eq(schema.agentRuns.status, 'running'))).limit(1)
  const [queued] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, 'rethink_strategy'), sql`${schema.jobs.status} in ('queued', 'running')`, sql`${schema.jobs.payload}->>'projectId' = ${project.id}`)).limit(1)
  const view = (x: typeof active) => x && { id: x.id, version: x.version, status: x.status, kind: x.kind, summary: x.summary, channels: x.channels, changes: x.changes, byAgent: x.byAgent, createdAt: x.createdAt.toISOString(), decidedAt: x.decidedAt?.toISOString() ?? null }
  return {
    today: d,
    project: { id: project.id, slug: project.slug, name: project.name, setup: { state: project.setup?.state ?? 'ready', analysis: project.setup?.analysis ?? null, site: project.setup?.site ?? null, budget: project.setup?.budget ?? null, plan: project.setup?.plan ?? null } },
    details,
    rethinking: !!(running || queued),
    goals,
    active: view(active),
    pending: view(pending),
    history: history.filter(h => h.changes.length).map(view),
    stats,
    autonomy: project.autonomy,
    lastReview: lastReview ? { at: lastReview.at.toISOString(), text: String(lastReview.detail.text ?? '') } : null,
  }
})
