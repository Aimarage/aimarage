import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { addDays } from '~~/shared/utils/dates'
import { DONE_STATUSES } from '~~/shared/utils/domain'
import { today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { kpiSeries } from '~~/server/services/views'
import { projectCond } from '~~/server/lib/access'
import { statsConfigured, utmSummary } from '~~/server/lib/traffic'
import { listGoals } from '~~/server/lib/goals'
import { countsAsDone } from '~~/shared/utils/task-state'
import { liveMatcher } from '~~/shared/utils/channel-live'

const query = z.object({
  project: z.string().max(60).optional(),
  days: z.coerce.number().int().min(7).max(90).default(30),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  const access = await accessOf(db, s)
  const d = today(s.workspace.timezone)
  const end = addDays(d, -1)
  const from = addDays(d, -q.days)
  const projects = project ? [project] : await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, s.workspace.id), sql`${schema.projects.archivedAt} is null`, projectCond(access, schema.projects.id, false))).orderBy(schema.projects.sortOrder)

  const metrics = []
  for (const p of projects) {
    for (const k of p.kpis) {
      const series = await kpiSeries(db, p.id, k.key, end, q.days)
      const sum = series.series.reduce<number>((a, v) => a + (v ?? 0), 0)
      metrics.push({ projectId: p.id, key: k.key, label: k.label, series: series.series, last: series.value, sum, hasData: series.series.some(v => v !== null) })
    }
  }

  const scope = and(eq(schema.tasks.workspaceId, s.workspace.id), project ? eq(schema.tasks.projectId, project.id) : projectCond(access, schema.tasks.projectId))
  const doneRows = await db.select({ category: schema.tasks.category, n: sql<number>`count(*)::int` }).from(schema.tasks)
    .where(and(scope, inArray(schema.tasks.status, DONE_STATUSES), sql`(${schema.tasks.doneAt} at time zone ${s.workspace.timezone})::date >= ${from}`))
    .groupBy(schema.tasks.category)
  const resultRows = await db.select({ channel: sql<string>`coalesce(${schema.tasks.channel}, '-')`, category: schema.tasks.category, metric: schema.results.metric, total: sql<number>`sum(${schema.results.value})::float`, n: sql<number>`count(*)::int` })
    .from(schema.results).innerJoin(schema.tasks, eq(schema.tasks.id, schema.results.taskId))
    .where(and(scope, sql`${schema.results.measuredOn} >= ${from}`))
    .groupBy(sql`1`, schema.tasks.category, schema.results.metric)
    .orderBy(sql`4 desc`)
  const goals = (await listGoals(db, s.workspace.id, d, { projectId: project?.id ?? null, access })).filter(g => g.targetValue)
  const reports = await db.select().from(schema.reports).where(and(eq(schema.reports.workspaceId, s.workspace.id), inArray(schema.reports.kind, ['woche', 'monat']))).orderBy(desc(schema.reports.periodStart)).limit(5)
  const recent = await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, projectId: schema.tasks.projectId, category: schema.tasks.category, doneAt: schema.tasks.doneAt, postedUrl: schema.tasks.postedUrl })
    .from(schema.tasks).where(and(scope, inArray(schema.tasks.status, DONE_STATUSES))).orderBy(desc(schema.tasks.doneAt)).limit(10)

  const channels = await db.select().from(schema.channels).where(and(eq(schema.channels.workspaceId, s.workspace.id), project ? eq(schema.channels.projectId, project.id) : projectCond(access, schema.channels.projectId))).orderBy(schema.channels.sortOrder)
  const doneTasks = await db.select({ projectId: schema.tasks.projectId, title: schema.tasks.title, channel: schema.tasks.channel, status: schema.tasks.status }).from(schema.tasks)
    .where(and(scope, inArray(schema.tasks.category, ['verzeichnis', 'launch', 'community', 'pflege']), inArray(schema.tasks.status, ['erledigt', 'ausgewertet', 'wartet'])))
  const isLive = liveMatcher(doneTasks.filter(t => countsAsDone(t.status)))

  const traffic = await utmSummary(db, s.workspace.id, projects.map(p => p.id), from, end)
  const statsSetUp = projects.some(p => statsConfigured(p.setup?.stats))

  return {
    traffic: { ...traffic, configured: statsSetUp, lastSync: projects.map(p => p.setup?.stats?.lastSync ?? null).filter(Boolean).sort().at(-1) ?? null, errors: projects.filter(p => p.setup?.stats?.error).map(p => ({ projectId: p.id, error: p.setup.stats!.error! })) },
    channels: channels.map(c => ({ id: c.id, projectId: c.projectId, group: c.group, name: c.name, status: c.status !== 'live' && isLive(c) ? 'live' as const : c.status, url: c.url })),
    from,
    to: end,
    days: q.days,
    metrics,
    done: doneRows,
    results: resultRows,
    goals,
    reports: reports.map(r => ({ id: r.id, kind: r.kind, periodStart: r.periodStart, periodEnd: r.periodEnd, text: r.text })),
    recent: recent.map(r => ({ ...r, doneAt: r.doneAt?.toISOString() ?? null })),
  }
})
