import { taskBlockedPlatform } from '../../shared/utils/blocked-platforms'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { addDays } from '../../shared/utils/dates'
import { expandRecurrence, type Occurrence } from '../../shared/utils/recurrence'
import type { DbOrTx } from './db'
import { schema } from './db'
import { planAllowsMail } from '../../shared/utils/coldmail'
import { STRATEGY_CATEGORIES } from '../../shared/utils/plan'
import { now } from './clock'
import { createTask, updateTask } from './tasks'
import { hostOf, isListingUpdate, listingConflict, listingRegister, openListings, taskDirectories, type ListingEntry, type OpenListing } from './listings'

export const HORIZON_DAYS = 21

type Recurrence = typeof schema.recurrences.$inferSelect
type Campaign = typeof schema.campaigns.$inferSelect

interface Context {
  recs: Recurrence[]
  campaigns: Map<string, Campaign>
  projectIds: string[]
  agentPlanned: Set<string>
  allStrategy: boolean
  setups: Map<string, typeof schema.projects.$inferSelect['setup']>
}

async function loadContext(db: DbOrTx, workspaceId: string): Promise<Context> {
  const recs = await db.select().from(schema.recurrences).where(and(eq(schema.recurrences.workspaceId, workspaceId), eq(schema.recurrences.active, true)))
  const camps = await db.select().from(schema.campaigns).where(eq(schema.campaigns.workspaceId, workspaceId))
  const projects = await db.select({ id: schema.projects.id, setup: schema.projects.setup }).from(schema.projects)
    .where(and(eq(schema.projects.workspaceId, workspaceId), isNull(schema.projects.archivedAt)))
    .orderBy(schema.projects.sortOrder)
  const ids = projects.map(p => p.id)
  return { recs, campaigns: new Map(camps.map(c => [c.id, c])), projectIds: ids, agentPlanned: new Set(projects.filter(p => p.setup?.plan === 'agent').map(p => p.id)), allStrategy: await allHaveStrategy(db, ids), setups: new Map(projects.map(p => [p.id, p.setup])) }
}

// Alle Projekte haben eine aktive Strategie: dann keine projektlosen Sammeltermine aus dem Startplan mehr.
export async function allHaveStrategy(db: DbOrTx, projectIds: string[]): Promise<boolean> {
  if (!projectIds.length) return false
  const rows = await db.selectDistinct({ id: schema.strategies.projectId }).from(schema.strategies).where(and(inArray(schema.strategies.projectId, projectIds), eq(schema.strategies.status, 'aktiv')))
  return rows.length >= projectIds.length
}

// Projektlose Startplan-Termine einmalig verwerfen, sobald alle Projekte eine aktive Strategie haben.
export async function dropProjectlessPlanTasks(db: DbOrTx, workspaceId: string): Promise<string[]> {
  const projects = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.workspaceId, workspaceId), isNull(schema.projects.archivedAt)))
  if (!(await allHaveStrategy(db, projects.map(p => p.id)))) return []
  const recs = (await db.select().from(schema.recurrences).where(eq(schema.recurrences.workspaceId, workspaceId))).filter(isPlanRecurrence).map(r => r.id)
  if (!recs.length) return []
  const rows = await db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, workspaceId), isNull(schema.tasks.projectId), inArray(schema.tasks.recurrenceId, recs), inArray(schema.tasks.status, ['geplant', 'entwurf_fertig'])))
  const out: string[] = []
  for (const t of rows) {
    await updateTask(db, t, { status: 'verworfen' }, { type: 'agent' })
    await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: true, text: 'Verworfen: Sammeltermin aus dem Startplan ohne Projekt. Jedes Projekt hat jetzt eine eigene Strategie; Community-Antworten entstehen nur noch zu echten Threads, Posts und Einträge plant die Strategie je Projekt.', createdAt: now() })
    out.push(t.code)
  }
  return out
}

export function isPlanRecurrence(rec: Pick<Recurrence, 'strategyChannel' | 'category'>): boolean {
  return !rec.strategyChannel && (STRATEGY_CATEGORIES as readonly string[]).includes(rec.category)
}

function expand(ctx: Context, rec: Recurrence, from: string, to: string): Occurrence[] {
  const camp = rec.campaignId ? ctx.campaigns.get(rec.campaignId) ?? null : null
  const occ = expandRecurrence(rec, camp, ctx.projectIds, from, to)
  if (!isPlanRecurrence(rec)) return occ
  return occ.filter(o => (o.projectId ? !ctx.agentPlanned.has(o.projectId) : !ctx.allStrategy))
}

export async function materializeRecurrences(db: DbOrTx, workspaceId: string, from: string, horizonDays = HORIZON_DAYS): Promise<number> {
  const ctx = await loadContext(db, workspaceId)
  const to = addDays(from, horizonDays)
  let created = 0
  const listings = new Map<string, { project: typeof schema.projects.$inferSelect, register: ListingEntry[], open: OpenListing[] } | null>()
  const listingsOf = async (projectId: string) => {
    if (!listings.has(projectId)) {
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
      listings.set(projectId, project ? { project, register: await listingRegister(db, project), open: await openListings(db, project) } : null)
    }
    return listings.get(projectId)!
  }
  for (const rec of ctx.recs) {
    if (rec.agentStep && !planAllowsMail({ category: rec.category, draftKind: rec.draftKind, title: rec.title, description: rec.description })) continue
    const occ = expand(ctx, rec, from, to)
    if (!occ.length) continue
    const existing = await db.select({ key: schema.tasks.occurrenceKey }).from(schema.tasks)
      .where(and(eq(schema.tasks.recurrenceId, rec.id), inArray(schema.tasks.occurrenceKey, occ.map(o => o.key))))
    const have = new Set(existing.map(e => e.key))
    for (const o of occ) {
      if (have.has(o.key)) continue
      if (o.projectId && taskBlockedPlatform({ setup: ctx.setups.get(o.projectId) }, { title: rec.title, category: rec.category, channel: rec.channel, description: rec.description })) continue
      const l = rec.category === 'verzeichnis' && o.projectId ? await listingsOf(o.projectId) : null
      if (l && await listingConflict(db, l.project, { title: rec.title, channel: rec.channel }, l)) continue
      const row = await createTask(db, {
        workspaceId,
        projectId: o.projectId,
        campaignId: rec.campaignId,
        recurrenceId: rec.id,
        occurrenceKey: o.key,
        title: rec.title,
        description: rec.description,
        category: rec.category,
        channel: rec.channel,
        dueDate: o.date,
        dueTime: rec.dueTime,
        durationMin: rec.durationMin,
        estimateMin: rec.estimateMin,
        prio: rec.prio,
        agentStep: rec.agentStep,
        humanStep: rec.humanStep,
        assigneeUserId: rec.humanStep ? rec.assigneeUserId : null,
        draftKind: rec.draftKind,
        metric: rec.metric,
        strategyChannel: rec.strategyChannel ?? ((STRATEGY_CATEGORIES as readonly string[]).includes(rec.category) ? rec.category : null),
      })
      if (l) l.open.push({ id: row.id, code: row.code, title: row.title, update: isListingUpdate(row.title), domains: taskDirectories(row, hostOf(l.project.url)), dueDate: row.dueDate, createdAt: row.createdAt })
      created++
    }
  }
  return created
}

export interface PreviewItem {
  recurrenceId: string
  projectId: string | null
  date: string
  dueTime: string | null
  durationMin: number
  title: string
  category: Recurrence['category']
  agentStep: string | null
  humanStep: string | null
  assigneeUserId: string | null
  draftKind: string | null
}

export async function previewRecurrences(db: DbOrTx, workspaceId: string, from: string, to: string, projectId?: string | null): Promise<PreviewItem[]> {
  const ctx = await loadContext(db, workspaceId)
  const out: PreviewItem[] = []
  for (const rec of ctx.recs) {
    for (const o of expand(ctx, rec, from, to)) {
      if (projectId && o.projectId !== projectId) continue
      out.push({ recurrenceId: rec.id, projectId: o.projectId, date: o.date, dueTime: rec.dueTime, durationMin: rec.durationMin, title: rec.title, category: rec.category, agentStep: rec.agentStep, humanStep: rec.humanStep, assigneeUserId: rec.assigneeUserId, draftKind: rec.draftKind })
    }
  }
  return out
}
