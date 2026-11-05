import { and, eq, isNull } from 'drizzle-orm'
import { OPEN_STATUSES } from '../../shared/utils/domain'
import { RESEARCH_PREFIX, taskType } from '../../shared/utils/drafting'
import { logActivity } from './activity'
import { addMonths, startOfMonth, addDays } from '../../shared/utils/dates'
import { today } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { structureLegacyGoals } from './goals'
import { connectExistingProject } from './strategy'

export async function connectLoop(db: Db): Promise<number> {
  const wss = await db.select().from(schema.workspaces)
  let n = 0
  for (const ws of wss) {
    const d = today(ws.timezone)
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.workspaceId, ws.id)).orderBy(schema.campaigns.startDate).limit(1)
    const start = campaign?.startDate ?? d
    const deadline = addDays(startOfMonth(addMonths(start, 4)), -1)
    await upgradeWorkspace(db, ws, d)
    await structureLegacyGoals(db, ws.id, start, deadline)
    const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))
    for (const p of projects) {
      if (p.setup?.state === 'onboarding') continue
      if (await connectExistingProject(db, p, start > d ? start : d)) n++
    }
  }
  return n
}

const KNOWN_START: Record<string, { metrics: Record<string, number>, memory: string[] }> = {
  BIT: { metrics: { artists: 0, releases: 15 }, memory: ['Startstand 07.10.2026: 15 Releases im Katalog, Künstler-Warteliste pausiert (0 Einträge laut /api/v1/artist-signup).'] },
}

export async function upgradeWorkspace(db: Db, ws: typeof schema.workspaces.$inferSelect, d: string): Promise<void> {
  const done = new Set(ws.settings?.upgrades ?? [])
  const add: string[] = []
  if (!done.has('weights6')) {
    const rows = await db.select().from(schema.strategies).where(eq(schema.strategies.workspaceId, ws.id))
    for (const r of rows) {
      const channels = r.channels.map(c => ({ ...c, weight: Math.min(6, Math.max(1, Math.round(c.weight) + 1)) }))
      const changes = r.changes.map(c => ({ ...c, from: c.from == null ? c.from : c.from + 1, to: c.to == null ? c.to : c.to + 1 }))
      await db.update(schema.strategies).set({ channels, changes }).where(eq(schema.strategies.id, r.id))
    }
    add.push('weights6')
  }
  if (!done.has('startvalues1')) {
    const projects = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))
    for (const p of projects) {
      const k = KNOWN_START[p.code]
      if (!k || ws.demo) continue
      for (const [key, value] of Object.entries(k.metrics)) {
        await db.insert(schema.metrics).values({ projectId: p.id, key, day: d, value, source: 'start' }).onConflictDoNothing()
      }
      for (const text of k.memory) await db.insert(schema.projectMemory).values({ projectId: p.id, kind: 'fakt', text })
    }
    add.push('startvalues1')
  }
  if (!done.has('research_notes1')) {
    await researchOutOfApprovals(db, ws.id)
    add.push('research_notes1')
  }
  if (add.length) {
    const [cur] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
    await db.update(schema.workspaces).set({ settings: { ...cur!.settings, upgrades: [...done, ...add] } }).where(eq(schema.workspaces.id, ws.id))
  }
}

export async function researchOutOfApprovals(db: Db, workspaceId: string): Promise<number> {
  const rows = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.drafts.status, 'offen')))
  let n = 0
  for (const { draft, task } of rows) {
    if (taskType(task) !== 'research') continue
    await db.transaction(async (tx) => {
      await tx.update(schema.drafts).set({ status: 'ersetzt' }).where(eq(schema.drafts.id, draft.id))
      await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `${RESEARCH_PREFIX}\n${draft.body}\n\n(Aus den Freigaben übernommen: Recherche ist eine interne Notiz, nichts zum Veröffentlichen.)` })
      if (OPEN_STATUSES.includes(task.status)) {
        await tx.update(schema.tasks).set({ status: 'erledigt', doneAt: new Date(), updatedAt: new Date() }).where(eq(schema.tasks.id, task.id))
        await logActivity(tx, { workspaceId, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'research_done', detail: { title: task.title } })
      }
    })
    n++
  }
  return n
}
