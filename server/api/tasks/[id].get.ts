import { and, asc, desc, eq } from 'drizzle-orm'
import { describeRule } from '~~/shared/utils/recurrence'
import { buildUtmUrl } from '~~/shared/utils/utm'
import { getDb, schema } from '~~/server/lib/db'
import { ownerOf } from '~~/server/lib/tasks'
import { agentReady } from '~~/server/lib/agent'
import { pendingJobs } from '~~/server/lib/jobs'
import { projectCond } from '~~/server/lib/access'
import { canPublishTask } from '~~/server/lib/outlets'
import { withChannelPlaces } from '~~/server/lib/channel-places'
import { socialTarget, targetAccounts, taskPlatform, zonedToUtc } from '~~/server/lib/publish'
import { taskWhereOf } from '~~/server/lib/where'
import { linksOf } from '~~/server/lib/task-links'
import { mailInfo } from '~~/server/lib/mail'
import { checkKind } from '~~/shared/utils/task-check'
import { todoFacts } from '~~/server/lib/todo'
import { replySourceOf } from '~~/shared/utils/reply-source'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  const project = t.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, t.projectId)))[0] ?? null : null
  const drafts = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t.id)).orderBy(desc(schema.drafts.version))
  const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, t.id)).orderBy(asc(schema.taskNotes.createdAt))
  const history = await db.select().from(schema.activity).where(eq(schema.activity.taskId, t.id)).orderBy(desc(schema.activity.createdAt)).limit(100)
  const results = await db.select().from(schema.results).where(eq(schema.results.taskId, t.id)).orderBy(desc(schema.results.measuredOn))
  const access = await accessOf(db, s)
  const dependsOn = t.dependsOnId ? (await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, status: schema.tasks.status }).from(schema.tasks).where(and(eq(schema.tasks.id, t.dependsOnId), projectCond(access, schema.tasks.projectId))))[0] ?? null : null
  const dependents = await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, status: schema.tasks.status }).from(schema.tasks).where(and(eq(schema.tasks.dependsOnId, t.id), projectCond(access, schema.tasks.projectId)))
  const rec = t.recurrenceId ? (await db.select().from(schema.recurrences).where(eq(schema.recurrences.id, t.recurrenceId)))[0] ?? null : null
  const busy = (await pendingJobs(db, s.workspace.id)).some(j => j.type === 'draft_task' && j.taskId === t.id)
  const target = project && canPublishTask(t) ? socialTarget(s.workspace, project) : null
  const [placed] = await withChannelPlaces(db, [t])
  const accounts = targetAccounts(target, placed)
  const [post] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, t.id)).orderBy(desc(schema.socialPosts.createdAt)).limit(1)
  const where = await taskWhereOf(db, s.workspace, t, project, drafts[0]?.recipient)
  const cur = drafts.find(d => d.status === 'offen' || d.status === 'freigegeben') ?? null
  const todo = await todoFacts(db, s.workspace, project, t, where, cur?.kind ?? null, notes.map(n => n.text))
  const mail = await mailInfo(db, t.id, 0)
  const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, t.id)).orderBy(desc(schema.agentRuns.startedAt)).limit(10)
  return {
    task: { ...t, owner: ownerOf(t, agentReady(s.workspace)), checkKind: checkKind(t) },
    project: project ? { id: project.id, slug: project.slug, name: project.name, color: project.color, url: project.url } : null,
    utmUrl: buildUtmUrl(t.targetUrl ?? project?.url, t),
    where,
    todo,
    links: await linksOf(db, t),
    mail,
    source: replySourceOf({ description: t.description, createdAt: t.createdAt, title: t.title, notes, mailDate: mail?.date ?? null }),
    drafts,
    notes,
    history: history.map(h => ({ ...h, createdAt: h.createdAt.toISOString() })),
    results,
    dependsOn,
    dependents,
    recurrence: rec ? { id: rec.id, rule: rec.rule, text: describeRule(rec.rule), active: rec.active, untilDate: rec.untilDate } : null,
    agentBusy: busy,
    outlet: {
      possible: canPublishTask(t),
      platform: taskPlatform(placed!) ?? accounts[0]?.platform ?? null,
      accounts: accounts.map(a => ({ platform: a.platform, name: a.name })),
      live: !!s.workspace.settings?.publishLive,
      at: t.dueDate ? zonedToUtc(t.dueDate, t.dueTime, s.workspace.timezone).toISOString() : null,
      post: post ? { status: post.status, scheduledAt: post.scheduledAt.toISOString(), updatedAt: post.updatedAt.toISOString(), platforms: post.platforms, error: post.error ?? (post.results.filter(r => r.error).map(r => r.error).join('; ') || null) } : null,
    },
    runs: runs.map(r => ({ id: r.id, job: r.job, status: r.status, startedAt: r.startedAt.toISOString(), summary: r.summary, tokensIn: r.tokensIn, tokensOut: r.tokensOut })),
  }
})
