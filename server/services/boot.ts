import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { budgetOf } from '../../shared/utils/time-budget'
import { initials } from '../../shared/utils/domain'
import { projectAccess, projectCond } from '../lib/access'
import { agentReady, workspaceLlm } from '../lib/agent'
import type { SessionInfo } from '../lib/auth'
import { now, today } from '../lib/clock'
import type { Db } from '../lib/db'
import { schema } from '../lib/db'
import { bootExtras } from '../lib/extensions'
import { config } from '../lib/config'
import { foldersAllowed } from '../lib/folder'
import { llmStatus } from '../lib/llm'
import { previewAvailable, previewOnly } from '../lib/preview'
import { reviewerAsk } from '../lib/ai-reviewer'
import { openTaskViews } from '../lib/task-view'
import { countPasskeys, passkeySnoozed } from '../lib/webauthn'

export async function bootData(db: Db, s: SessionInfo) {
  const ws = s.workspace
  const access = await projectAccess(db, { workspaceId: ws.id, userId: s.user.id, role: s.role }, s)
  const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt), projectCond(access, schema.projects.id, false))).orderBy(schema.projects.sortOrder, schema.projects.name)
  const views = await openTaskViews(db, ws, projectCond(access, schema.tasks.projectId))
  const todo = new Map<string, string>()
  for (const r of views) if (r.view.bucket === 'yours' && r.view.draft) todo.set(r.task.id, r.task.projectId ?? 'alle')
  const proposals = await db.select({ projectId: schema.strategies.projectId, n: sql<number>`count(*)::int` }).from(schema.strategies)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.strategies.projectId))
    .where(and(eq(schema.strategies.workspaceId, ws.id), eq(schema.strategies.status, 'vorschlag'), sql`coalesce(${schema.projects.setup}->>'state', 'ready') <> 'onboarding'`, projectCond(access, schema.strategies.projectId, false)))
    .groupBy(schema.strategies.projectId)
  const approvalMap: Record<string, number> = {}
  for (const pid of todo.values()) approvalMap[pid] = (approvalMap[pid] ?? 0) + 1
  for (const p of proposals) approvalMap[p.projectId] = (approvalMap[p.projectId] ?? 0) + p.n
  const members = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.memberships.role })
    .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.workspaceId, ws.id)).orderBy(schema.memberships.createdAt)
  const [lastRun] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.workspaceId, ws.id), sql`${schema.agentRuns.status} in ('ok', 'error')`)).orderBy(desc(schema.agentRuns.startedAt)).limit(1)
  const d = today(ws.timezone)
  const overdue: Record<string, number> = {}
  for (const r of views) if (r.view.overdue) overdue[r.task.projectId ?? 'alle'] = (overdue[r.task.projectId ?? 'alle'] ?? 0) + 1
  const [{ n: draftsToday } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.activity)
    .where(and(eq(schema.activity.workspaceId, ws.id), eq(schema.activity.action, 'draft_created'), sql`(${schema.activity.createdAt} at time zone ${ws.timezone})::date = ${d}`))
  const [campaign] = await db.select({ startDate: schema.campaigns.startDate }).from(schema.campaigns).where(eq(schema.campaigns.workspaceId, ws.id)).orderBy(schema.campaigns.startDate).limit(1)
  const cfg = workspaceLlm(ws)
  const status = llmStatus(cfg)
  const workspaces = await db.select({ id: schema.workspaces.id, name: schema.workspaces.name }).from(schema.memberships)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.memberships.userId, s.user.id)).orderBy(schema.memberships.createdAt)
  const passkeyCount = await countPasskeys(db, s.user.id)
  return {
    user: { id: s.user.id, name: s.user.name, email: s.user.email, initials: initials(s.user.name), locale: s.user.locale, prefs: s.user.prefs, hasPassword: !!s.user.passwordHash, passkeys: passkeyCount, passkeyOffer: passkeyCount === 0 && !passkeySnoozed(s.user.prefs), minutesPerDay: budgetOf(ws.settings, s.user.id) },
    workspace: { id: ws.id, name: ws.name, timezone: ws.timezone, demo: ws.demo, paused: !!ws.pausedAt, preview: previewOnly(ws) ? 'used' : await previewAvailable(db, ws) ? 'available' : null, reviewerAsk: reviewerAsk(ws) },
    features: { hosted: config.hosted, folders: foldersAllowed(), llmLocked: config.llmSettingsLocked },
    workspaces,
    auth: { password: config.authPassword },
    role: s.role,
    now: now().toISOString(),
    today: d,
    campaignStart: campaign?.startDate ?? null,
    projects: projects.map(p => ({ id: p.id, slug: p.slug, name: p.name, code: p.code, color: p.color, icon: p.icon, url: p.url, kpis: p.kpis, setupState: p.setup?.state ?? 'ready' })),
    approvals: approvalMap,
    overdue,
    members: members.map(m => ({ ...m, initials: initials(m.name) })),
    agent: {
      configured: status.configured,
      enabled: ws.settings?.agentEnabled !== false,
      ready: agentReady(ws),
      reason: status.reason,
      model: cfg.model,
      lastRunAt: lastRun?.startedAt?.toISOString() ?? null,
      lastRunSummary: lastRun?.summary ?? null,
      draftsToday,
    },
    extensions: await bootExtras(db, s),
  }
}

export type BootData = Awaited<ReturnType<typeof bootData>>
