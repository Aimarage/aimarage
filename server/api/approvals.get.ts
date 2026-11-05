import { and, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { projectCond } from '~~/server/lib/access'
import { markOf } from '~~/shared/utils/drafting'
import { repliesItself } from '~~/shared/utils/listening'
import { roleAtLeast } from '~~/shared/utils/domain'
import { trustSuggestions } from '~~/server/lib/trust'
import { latestFeedback } from '~~/server/services/client'
import { experimentLabel } from '~~/server/lib/experiments'
import { staleStrategies } from '~~/server/lib/release-focus'
import { draftLists, recentlyDone, type ReleasedRow } from '~~/server/lib/approval-lists'
import { whereLookup } from '~~/server/lib/where'
import { todoFacts } from '~~/server/lib/todo'

const query = z.object({ project: z.string().max(60).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  const cond = project ? eq(schema.tasks.projectId, project.id) : projectCond(await accessOf(db, s), schema.tasks.projectId)
  const lists = await draftLists(db, s.workspace, cond)
  const rows = lists.yours.filter(r => r.draft.status === 'offen')
  const selfRows = lists.yours.filter(r => r.draft.status === 'freigegeben')
  const released = { outgoing: lists.outgoing, soon: lists.soon }
  const done = await recentlyDone(db, s.workspace, cond)
  const pids = [...new Set([...rows, ...selfRows, ...released.soon, ...lists.claude].map(r => r.task.projectId).filter((x): x is string => !!x))]
  const projectList = pids.length ? await db.select().from(schema.projects).where(inArray(schema.projects.id, pids)) : []
  const projectsById = new Map(projectList.map(p => [p.id, p]))
  const whereOf = await whereLookup(db, s.workspace, projectList)
  const todoOf = async (r: { task: typeof schema.tasks.$inferSelect, draft: typeof schema.drafts.$inferSelect }) => {
    const w = whereOf({ ...r.task, draftKind: r.task.draftKind ?? r.draft.kind })
    const f = await todoFacts(db, s.workspace, r.task.projectId ? projectsById.get(r.task.projectId) ?? null : null, r.task, w, r.draft.kind)
    return { ...f, place: w.place, placeKind: w.kind, missing: w.missing, to: r.draft.recipient, status: r.task.status, category: r.task.category, draftKind: r.draft.kind }
  }
  const soonItem = async (r: ReleasedRow) => ({
    draftId: r.draft.id,
    taskId: r.task.id,
    code: r.task.code,
    title: r.task.title,
    projectId: r.task.projectId,
    kind: r.draft.kind,
    platform: markOf({ ...r.task, draftKind: r.draft.kind }),
    dueDate: r.task.dueDate,
    dueTime: r.task.dueTime,
    overdue: r.view.overdue,
    visibleFrom: r.view.visibleFrom,
    open: r.draft.status === 'offen',
    todo: await todoOf(r),
  })
  const infoRows = rows.length ? await db.select({ taskId: schema.taskNotes.taskId, at: schema.taskNotes.createdAt }).from(schema.taskNotes)
    .where(and(inArray(schema.taskNotes.taskId, rows.map(r => r.task.id)), eq(schema.taskNotes.byAgent, true), like(schema.taskNotes.text, 'Info nötig:%'))) : []
  const client = await latestFeedback(db, rows.map(r => r.draft.id))
  const infoNeeded = (taskId: string, since: Date) => infoRows.some(n => n.taskId === taskId && n.at.getTime() >= since.getTime() - 2000)
  const props = await db.select({ st: schema.strategies, p: schema.projects }).from(schema.strategies)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.strategies.projectId))
    .where(and(eq(schema.strategies.workspaceId, s.workspace.id), eq(schema.strategies.status, 'vorschlag'), sql`coalesce(${schema.projects.setup}->>'state', 'ready') <> 'onboarding'`, project ? eq(schema.strategies.projectId, project.id) : projectCond(await accessOf(db, s), schema.strategies.projectId)))
    .orderBy(desc(schema.strategies.createdAt))
  const exps = await db.select({ e: schema.experiments, p: schema.projects }).from(schema.experiments)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.experiments.projectId))
    .where(and(eq(schema.experiments.workspaceId, s.workspace.id), eq(schema.experiments.status, 'vorschlag'), isNull(schema.experiments.strategyId), project ? eq(schema.experiments.projectId, project.id) : projectCond(await accessOf(db, s), schema.experiments.projectId)))
    .orderBy(desc(schema.experiments.createdAt))
  const visible = project ? [project.id] : (await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.workspaceId, s.workspace.id), projectCond(await accessOf(db, s), schema.projects.id, false)))).map(p => p.id)
  const stale = await staleStrategies(db, s.workspace, visible)
  const trust: { projectId: string, projectName: string, kind: string }[] = []
  if (roleAtLeast(s.role, 'admin')) {
    const list = project ? [project] : await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, s.workspace.id), sql`${schema.projects.archivedAt} is null`, projectCond(await accessOf(db, s), schema.projects.id, false)))
    for (const p of list) for (const kind of await trustSuggestions(db, s.workspace, p)) trust.push({ projectId: p.id, projectName: p.name, kind })
  }
  return {
    trust,
    stale: stale.map(x => ({ projectId: x.projectId, projectName: x.projectName, slug: x.slug, reason: x.reason, label: x.label, old: x.old, proposalId: x.proposalId })),
    outgoing: released.outgoing.map(r => ({
      draftId: r.draft.id,
      taskId: r.task.id,
      code: r.task.code,
      title: r.task.title,
      projectId: r.task.projectId,
      kind: r.draft.kind,
      platform: markOf({ ...r.task, draftKind: r.draft.kind }),
      at: r.at?.toISOString() ?? null,
      byClaude: r.draft.approvedVia === 'mcp',
      byReviewer: r.draft.approvedVia === 'reviewer',
      goesOut: r.goesOut,
      running: r.running,
    })),
    done: done.map(r => ({
      draftId: r.draft.id,
      taskId: r.task.id,
      title: r.task.title,
      projectId: r.task.projectId,
      kind: r.draft.kind,
      platform: markOf({ ...r.task, draftKind: r.draft.kind }),
      at: r.task.doneAt!.toISOString(),
    })),
    experiments: exps.map(r => ({ id: r.e.id, projectId: r.p.id, projectName: r.p.name, hypothesis: r.e.hypothesis, label: experimentLabel(r.e), createdAt: r.e.createdAt.toISOString() })),
    proposals: props.map(r => ({ id: r.st.id, projectId: r.p.id, projectName: r.p.name, count: r.st.changes.length, summary: r.st.summary, createdAt: r.st.createdAt.toISOString(), changes: r.st.changes.map(c => ({ name: c.name, change: c.change })) })),
    claude: await Promise.all(lists.claude.map(soonItem)),
    soon: await Promise.all(released.soon.map(soonItem)),
    items: [
      ...await Promise.all(rows.map(async (r) => {
        const info = infoNeeded(r.task.id, r.draft.createdAt)
        const out = r.view.next === 'approve'
        return {
          draftId: r.draft.id,
          taskId: r.task.id,
          code: r.task.code,
          title: r.task.title,
          projectId: r.task.projectId,
          category: r.task.category,
          kind: r.draft.kind,
          platform: markOf({ ...r.task, draftKind: r.draft.kind }),
          version: r.draft.version,
          byAgent: r.draft.byAgent,
          aiGenerated: r.draft.aiGenerated,
          createdAt: r.draft.createdAt.toISOString(),
          dueDate: r.task.dueDate,
          dueTime: r.task.dueTime,
          overdue: r.view.overdue,
          subject: r.draft.subject,
          infoNeeded: info,
          action: info ? 'info' as const : r.draft.kind === 'mail' ? 'mail' as const : out && repliesItself(r.task) ? 'reply' as const : out ? (r.draft.kind === 'article' ? 'article' as const : 'approve' as const) : 'self' as const,
          client: client.get(r.draft.id)?.verdict ?? null,
          todo: await todoOf(r),
        }
      })),
      ...await Promise.all(selfRows.map(async r => ({
        draftId: r.draft.id,
        taskId: r.task.id,
        code: r.task.code,
        title: r.task.title,
        projectId: r.task.projectId,
        category: r.task.category,
        kind: r.draft.kind,
        platform: markOf({ ...r.task, draftKind: r.draft.kind }),
        version: r.draft.version,
        byAgent: r.draft.byAgent,
        aiGenerated: r.draft.aiGenerated,
        createdAt: r.draft.createdAt.toISOString(),
        dueDate: r.task.dueDate,
        dueTime: r.task.dueTime,
        overdue: r.view.overdue,
        subject: r.draft.subject,
        infoNeeded: false,
        action: r.draft.kind === 'mail' ? 'sendMail' as const : 'self' as const,
        client: null,
        todo: await todoOf(r),
      }))),
    ],
  }
})
