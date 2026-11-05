import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { CLIENT_ACTIONS } from '~~/server/lib/activity'
import { today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { pendingJobs } from '~~/server/lib/jobs'
import { scheduleFor } from '~~/server/lib/worker'
import { canSeeProject, projectCond } from '~~/server/lib/access'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const access = await accessOf(db, s)
  const allRuns = await db.select({ run: schema.agentRuns, projectId: schema.tasks.projectId }).from(schema.agentRuns)
    .leftJoin(schema.tasks, eq(schema.tasks.id, schema.agentRuns.taskId))
    .where(eq(schema.agentRuns.workspaceId, s.workspace.id)).orderBy(desc(schema.agentRuns.startedAt)).limit(60)
  const runs = allRuns.filter(r => canSeeProject(access, r.run.projectId ?? r.projectId)).map(r => r.run)
  const feed = await db.select().from(schema.activity).where(and(eq(schema.activity.workspaceId, s.workspace.id), or(inArray(schema.activity.actor, ['agent', 'mcp']), inArray(schema.activity.action, CLIENT_ACTIONS)), projectCond(access, schema.activity.projectId))).orderBy(desc(schema.activity.createdAt)).limit(60)
  const [briefing] = await db.select().from(schema.reports).where(and(eq(schema.reports.workspaceId, s.workspace.id), eq(schema.reports.kind, 'briefing'))).orderBy(desc(schema.reports.periodStart)).limit(1)
  return {
    today: today(s.workspace.timezone),
    runs: runs.map(r => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, log: undefined })),
    feed: feed.map(f => ({ id: f.id, at: f.createdAt.toISOString(), action: f.action, projectId: f.projectId, taskId: f.taskId, detail: f.detail })),
    jobs: await pendingJobs(db, s.workspace.id),
    schedule: scheduleFor(s.workspace),
    briefing: briefing && access.all ? { date: briefing.periodStart, text: briefing.text, content: briefing.content } : null,
  }
})
