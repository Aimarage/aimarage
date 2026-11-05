import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { countsAsDone } from '../../shared/utils/task-state'
import { addDays, diffDays, startOfWeek } from '../../shared/utils/dates'
import type { Category } from '../../shared/utils/domain'
import { fixOwnDomain } from '../../shared/utils/own-domain'
import { fixTimeClaims, minutesPerDay } from '../../shared/utils/strategy-facts'
import { CATEGORY_DRAFT, CATEGORY_STEPS, cadenceRule, clampWeight, DEFAULT_TIME, fillDays, freqLevel, MAX_WEIGHT, STRATEGY_CATEGORIES, WEIGHT_PER_WEEK } from '../../shared/utils/plan'
import type { StrategyChange, StrategyChannel } from '../db/schema'
import { logActivity } from './activity'
import { now } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import { oldChannelNames, remapTasks } from './channel-match'
import { materializeRecurrences, previewRecurrences } from './materialize'
import { channelBlock, channelExcluded, ensureSetupTask, loadPlanGuard, wantsBlog } from './plan-guard'

export type StrategyRow = typeof schema.strategies.$inferSelect
type Project = typeof schema.projects.$inferSelect

export const CHANNEL_LABELS: Record<string, string> = {
  community: 'Communities und Foren',
  social: 'Social Media',
  content: 'Blog und Ratgeber',
  verzeichnis: 'Verzeichnisse',
  outreach: 'Presse und Partner',
  launch: 'Launches',
}

export function channelKey(name: string): string {
  return name.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kanal'
}

export function normalizeChannel(c: Partial<StrategyChannel> & { name: string }): StrategyChannel {
  const category = (STRATEGY_CATEGORIES as readonly string[]).includes(c.category ?? '') ? c.category! : 'social'
  return {
    key: c.key || channelKey(c.name),
    name: c.name.slice(0, 80),
    category,
    why: (c.why ?? '').slice(0, 400),
    goalIds: c.goalIds ?? [],
    weight: clampWeight(c.weight ?? 2),
    base: c.base ?? 0,
    days: fillDays(c.days, category).slice(0, 3),
    time: c.time === undefined ? DEFAULT_TIME[category] ?? null : c.time,
    active: c.active ?? true,
    places: cleanList(c.places, 8, 80),
    topics: cleanList(c.topics, 6, 140),
  }
}

export function cleanList(v: unknown, max: number, len: number): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.replace(/[–—]/g, '-').trim().slice(0, len)).filter(Boolean))].slice(0, max)
}

export async function activeStrategy(db: DbOrTx, projectId: string): Promise<StrategyRow | null> {
  const [s] = await db.select().from(schema.strategies).where(and(eq(schema.strategies.projectId, projectId), eq(schema.strategies.status, 'aktiv'))).orderBy(desc(schema.strategies.version)).limit(1)
  return s ?? null
}

export async function pendingProposal(db: DbOrTx, projectId: string): Promise<StrategyRow | null> {
  const [s] = await db.select().from(schema.strategies).where(and(eq(schema.strategies.projectId, projectId), eq(schema.strategies.status, 'vorschlag'))).orderBy(desc(schema.strategies.version)).limit(1)
  return s ?? null
}

async function nextVersion(db: DbOrTx, projectId: string): Promise<number> {
  const [r] = await db.select({ v: sql<number>`coalesce(max(${schema.strategies.version}), 0)::int` }).from(schema.strategies).where(eq(schema.strategies.projectId, projectId))
  return (r?.v ?? 0) + 1
}

export function applyChanges(channels: StrategyChannel[], changes: StrategyChange[]): StrategyChannel[] {
  const out = channels.map(c => ({ ...c }))
  for (const ch of changes) {
    const i = out.findIndex(c => c.key === ch.channelKey)
    const cur = i >= 0 ? out[i]! : null
    switch (ch.change) {
      case 'more':
        if (cur) cur.weight = clampWeight(ch.to ?? cur.weight + 1)
        if (cur) cur.active = true
        break
      case 'less':
        if (cur) cur.weight = clampWeight(ch.to ?? cur.weight - 1)
        break
      case 'pause':
        if (cur) cur.active = false
        break
      case 'resume':
        if (cur) cur.active = true
        break
      case 'remove':
        if (i >= 0) out.splice(i, 1)
        break
      case 'new':
        if (!cur && ch.channel) out.push(normalizeChannel(ch.channel))
        break
    }
  }
  return out
}

export function isSmallChange(ch: StrategyChange): boolean {
  if (ch.change !== 'more' && ch.change !== 'less') return false
  if (ch.from == null || ch.to == null) return true
  return Math.abs(ch.to - ch.from) <= 1
}

function managedLevel(c: StrategyChannel): number {
  if (!c.active) return 0
  if (!c.base) return c.weight
  const extra = WEIGHT_PER_WEEK[c.weight]! - (c.base ?? 0)
  return extra < 0.5 ? 0 : freqLevel(extra)
}

async function dropFutureOpen(db: DbOrTx, recurrenceId: string, today: string): Promise<string[]> {
  const rows = await db.delete(schema.tasks).where(and(
    eq(schema.tasks.recurrenceId, recurrenceId),
    eq(schema.tasks.status, 'geplant'),
    gt(schema.tasks.dueDate, today),
    sql`not exists (select 1 from drafts where drafts.task_id = ${schema.tasks.id})`,
  )).returning({ code: schema.tasks.code })
  return rows.map(r => r.code)
}

// Sammel-Verwerfen beim Strategiewechsel im Verlauf festhalten (ein Eintrag je Vorgang).
export async function logDropped(db: DbOrTx, project: Pick<Project, 'id' | 'workspaceId' | 'name'>, codes: string[], reason: string): Promise<void> {
  if (!codes.length) return
  await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: 'agent', action: 'tasks_reconciled', detail: { title: project.name, count: codes.length, codes: codes.slice(0, 20), reason }, at: now() })
}

export async function syncRecurrences(db: DbOrTx, project: Project, channels: StrategyChannel[], today: string, ownerId: string | null, startFrom?: string): Promise<void> {
  const managed = await db.select().from(schema.recurrences).where(and(eq(schema.recurrences.projectId, project.id), isNotNull(schema.recurrences.strategyChannel), isNull(schema.recurrences.campaignId)))
  const byKey = new Map(managed.map(r => [r.strategyChannel!, r]))
  const guard = await loadPlanGuard(db, project)
  const dropped: string[] = []
  for (const c of channels) {
    const excluded = channelExcluded(guard, c)
    const block = c.active && !excluded ? channelBlock(guard, c) : null
    if (block) await ensureSetupTask(db, project, block, c, ownerId, today)
    else if (c.active && !excluded && wantsBlog(guard, c)) await ensureSetupTask(db, project, { kind: 'blog' }, c, ownerId, today)
    const rule = block || excluded ? null : cadenceRule(managedLevel(c), c.days, c.category)
    const rec = byKey.get(c.key)
    byKey.delete(c.key)
    const steps = CATEGORY_STEPS[c.category as Category]
    if (!rule) {
      if (rec?.active) {
        await db.update(schema.recurrences).set({ active: false }).where(eq(schema.recurrences.id, rec.id))
        dropped.push(...await dropFutureOpen(db, rec.id, today))
      }
      continue
    }
    if (rec) {
      if (rec.rule !== rule || !rec.active || rec.title !== c.name || rec.dueTime !== (c.time ?? null)) {
        await db.update(schema.recurrences).set({ rule, active: true, title: c.name, dueTime: c.time ?? null, description: c.why || null, ...(startFrom ? { startDate: startFrom } : {}) }).where(eq(schema.recurrences.id, rec.id))
        await dropFutureOpen(db, rec.id, today)
      }
      else if (startFrom && rec.startDate !== startFrom) {
        await db.update(schema.recurrences).set({ startDate: startFrom }).where(eq(schema.recurrences.id, rec.id))
        await dropFutureOpen(db, rec.id, today)
      }
      continue
    }
    await db.insert(schema.recurrences).values({
      workspaceId: project.workspaceId,
      projectId: project.id,
      projectMode: 'fixed',
      rule,
      title: c.name,
      description: c.why || null,
      category: c.category as Category,
      channel: c.name,
      agentStep: steps?.agent ?? 'Entwurf',
      humanStep: steps?.human ?? 'Prüfen',
      assigneeUserId: ownerId,
      dueTime: c.time ?? null,
      durationMin: 30,
      estimateMin: steps?.estimate ?? 15,
      draftKind: CATEGORY_DRAFT[c.category as Category] ?? 'text',
      prio: 'P2',
      startDate: startFrom ?? today,
      strategyChannel: c.key,
    })
  }
  for (const rec of byKey.values()) {
    if (!rec.active) continue
    await db.update(schema.recurrences).set({ active: false }).where(eq(schema.recurrences.id, rec.id))
    dropped.push(...await dropFutureOpen(db, rec.id, today))
  }
  await logDropped(db, project, dropped, 'channel_off')
}

export async function enforcePlan(db: DbOrTx, project: Project, channels: StrategyChannel[], today: string): Promise<number> {
  let changed = 0
  const skipped: string[] = []
  for (const c of channels) {
    const base = c.base ?? 0
    if (base <= 0) continue
    const ratio = c.active ? Math.min(1, WEIGHT_PER_WEEK[c.weight]! / base) : 0
    const rows = await db.select({ t: schema.tasks, managed: schema.recurrences.strategyChannel }).from(schema.tasks)
      .leftJoin(schema.recurrences, eq(schema.recurrences.id, schema.tasks.recurrenceId))
      .where(and(
        eq(schema.tasks.projectId, project.id),
        eq(schema.tasks.strategyChannel, c.key),
        gt(schema.tasks.dueDate, today),
        sql`(${schema.tasks.skippedByPlan} or (${schema.tasks.status} = 'geplant' and not exists (select 1 from drafts where drafts.task_id = ${schema.tasks.id})))`,
      ))
      .orderBy(schema.tasks.dueDate, schema.tasks.dueTime)
    const weeks = new Map<string, typeof schema.tasks.$inferSelect[]>()
    for (const r of rows) {
      if (r.managed) continue
      const w = startOfWeek(r.t.dueDate!)
      weeks.set(w, [...(weeks.get(w) ?? []), r.t])
    }
    for (const [w, list] of weeks) {
      let keep = Math.round(list.length * ratio)
      if (keep === 0 && ratio > 0 && Math.floor(diffDays(w, '2026-01-05') / 7) % 2 === 0) keep = 1
      for (const [i, t] of list.entries()) {
        const skip = i >= keep
        if (skip && !t.skippedByPlan) {
          await db.update(schema.tasks).set({ status: 'verworfen', skippedByPlan: true, updatedAt: now() }).where(eq(schema.tasks.id, t.id))
          skipped.push(t.code)
          changed++
        }
        else if (!skip && t.skippedByPlan) {
          await db.update(schema.tasks).set({ status: 'geplant', skippedByPlan: false, updatedAt: now() }).where(eq(schema.tasks.id, t.id))
          changed++
        }
      }
    }
  }
  await logDropped(db, project, skipped, 'plan')
  return changed
}

export async function projectOwner(db: DbOrTx, projectId: string): Promise<string | null> {
  const [m] = await db.select({ u: schema.projectMembers.userId }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.role, 'owner'))).limit(1)
  return m?.u ?? null
}

export async function applyStrategy(db: DbOrTx, project: Project, s: StrategyRow, today: string, startFrom?: string): Promise<number> {
  const owner = await projectOwner(db, project.id)
  await syncRecurrences(db, project, s.channels, today, owner, startFrom)
  const n = await materializeRecurrences(db, project.workspaceId, today)
  await enforcePlan(db, project, s.channels, today)
  return n
}

// Inhaltliche Änderung (Kanal weg/pausiert/neu, Orte, Themen, Kurzfassung), nicht nur der Takt.
export function strategyShifted(prev: Pick<StrategyRow, 'summary' | 'channels'>, next: Pick<StrategyRow, 'summary' | 'channels'>): boolean {
  if ((prev.summary ?? '') !== (next.summary ?? '')) return true
  const sig = (c: StrategyChannel) => JSON.stringify([c.active, c.category, [...(c.places ?? [])].sort(), [...(c.topics ?? [])].sort()])
  const a = new Map(prev.channels.map(c => [c.key, sig(c)]))
  const b = new Map(next.channels.map(c => [c.key, sig(c)]))
  return a.size !== b.size || [...a].some(([k, v]) => b.get(k) !== v)
}

export function reconcileKey(projectId: string, strategyId: string, day: string): string {
  return `reconcile_tasks:${projectId}:${strategyId}:${day}`
}

export async function enqueueReconcile(db: DbOrTx, project: Pick<Project, 'id' | 'workspaceId'>, strategyId: string, day: string): Promise<boolean> {
  return enqueueJob(db, 'reconcile_tasks', { workspaceId: project.workspaceId, payload: { projectId: project.id }, dedupeKey: reconcileKey(project.id, strategyId, day), maxAttempts: 2 })
}

export async function activateStrategy(db: DbOrTx, project: Project, s: StrategyRow, today: string, by: { userId?: string | null, agent?: boolean, startFrom?: string }): Promise<number> {
  const prev = await activeStrategy(db, project.id)
  if (prev && prev.id !== s.id && strategyShifted(prev, s)) await enqueueReconcile(db, project, s.id, today)
  if (prev && prev.id !== s.id) await remapTasks(db, project.id, s.channels, await oldChannelNames(db, project.id))
  await db.update(schema.strategies).set({ status: 'abgeloest' }).where(and(eq(schema.strategies.projectId, project.id), eq(schema.strategies.status, 'aktiv'), ne(schema.strategies.id, s.id)))
  const [row] = await db.update(schema.strategies).set({ status: 'aktiv', decidedAt: now(), decidedByUserId: by.userId ?? null }).where(eq(schema.strategies.id, s.id)).returning()
  return applyStrategy(db, project, row!, today, by.startFrom)
}

export function projectSite(project: Pick<Project, 'url' | 'setup'>): string | null {
  return project.setup?.site?.url || project.url || null
}

export function fixChannelDomains(channels: StrategyChannel[], url: string | null): StrategyChannel[] {
  if (!url) return channels
  const f = (t: string) => fixOwnDomain(t, url)
  return channels.map(c => ({ ...c, name: f(c.name), why: f(c.why), places: c.places?.map(f), topics: c.topics?.map(f) }))
}

// Fakten in Strategie-Texten: eigene Domain aus der geprüften Website, Zeit aus dem Zeitbudget des Projekt-Owners.
export interface StrategyFacts { site: string | null, minutes: number }

export async function strategyFacts(db: DbOrTx, project: Project): Promise<StrategyFacts> {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, project.workspaceId))
  return { site: projectSite(project), minutes: minutesPerDay(ws?.settings, await projectOwner(db, project.id)) }
}

export function fixStrategyText(text: string, f: StrategyFacts): string {
  return fixTimeClaims(fixOwnDomain(text, f.site), f.minutes)
}

export function fixStrategyChannels(channels: StrategyChannel[], f: StrategyFacts): StrategyChannel[] {
  return fixChannelDomains(channels, f.site).map(c => ({ ...c, why: fixTimeClaims(c.why, f.minutes) }))
}

// Bestehende Strategien (aktiv und Vorschlag) korrigieren, idempotent.
export async function fixStrategies(db: DbOrTx): Promise<number> {
  const rows = await db.select().from(schema.strategies).where(inArray(schema.strategies.status, ['aktiv', 'vorschlag']))
  const projects = new Map<string, StrategyFacts | null>()
  let n = 0
  for (const s of rows) {
    if (!projects.has(s.projectId)) {
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, s.projectId))
      projects.set(s.projectId, p ? await strategyFacts(db, p) : null)
    }
    const f = projects.get(s.projectId)
    if (!f) continue
    const summary = s.summary ? fixStrategyText(s.summary, f) : s.summary
    const channels = fixStrategyChannels(s.channels, f)
    if (summary === s.summary && JSON.stringify(channels) === JSON.stringify(s.channels)) continue
    await db.update(schema.strategies).set({ summary, channels }).where(eq(schema.strategies.id, s.id))
    n++
  }
  return n
}

export async function createStrategyVersion(db: DbOrTx, project: Project, input: { channels: StrategyChannel[], changes?: StrategyChange[], summary?: string | null, status: StrategyRow['status'], kind: StrategyRow['kind'], byAgent: boolean }): Promise<StrategyRow> {
  const facts = await strategyFacts(db, project)
  const [row] = await db.insert(schema.strategies).values({
    workspaceId: project.workspaceId,
    projectId: project.id,
    version: await nextVersion(db, project.id),
    status: input.status,
    kind: input.kind,
    summary: input.summary ? fixStrategyText(input.summary, facts) : null,
    channels: fixStrategyChannels(input.channels.map(normalizeChannel), facts),
    changes: input.changes ?? [],
    byAgent: input.byAgent,
    createdAt: now(),
  }).returning()
  return row!
}

export async function changeStrategy(db: DbOrTx, project: Project, changes: StrategyChange[], today: string, opts: { kind: StrategyRow['kind'], byAgent: boolean, userId?: string | null, summary?: string | null }): Promise<{ strategy: StrategyRow, created: number }> {
  const cur = await activeStrategy(db, project.id)
  const channels = applyChanges(cur?.channels ?? [], changes)
  const s = await createStrategyVersion(db, project, { channels, changes, summary: opts.summary ?? cur?.summary ?? null, status: 'vorschlag', kind: opts.kind, byAgent: opts.byAgent })
  const created = await activateStrategy(db, project, s, today, { userId: opts.userId, agent: opts.byAgent })
  for (const ch of changes) {
    await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: opts.byAgent ? 'agent' : 'user', userId: opts.userId ?? null, action: 'strategy_adjusted', detail: { title: ch.name, change: ch.change, reason: ch.reason }, at: now() })
  }
  return { strategy: (await activeStrategy(db, project.id))!, created }
}

export async function approveProposal(db: DbOrTx, project: Project, proposal: StrategyRow, today: string, userId: string): Promise<number> {
  const cur = await activeStrategy(db, project.id)
  if (cur && proposal.changes.length && proposal.kind !== 'rethink') {
    await db.update(schema.strategies).set({ channels: applyChanges(cur.channels, proposal.changes) }).where(eq(schema.strategies.id, proposal.id))
  }
  const [fresh] = await db.select().from(schema.strategies).where(eq(schema.strategies.id, proposal.id))
  let n: number
  if (fresh!.kind === 'rethink') {
    const { applyRethinkPlan } = await import('./rethink')
    const r = await applyRethinkPlan(db, project, fresh!, today, userId)
    n = r.created + r.materialized
  }
  else n = await activateStrategy(db, project, fresh!, today, { userId })
  await db.update(schema.experiments).set({ status: 'laeuft', startDate: today, endDate: addDays(today, 13), decidedByUserId: userId }).where(and(eq(schema.experiments.strategyId, proposal.id), eq(schema.experiments.status, 'vorschlag')))
  await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: 'user', userId, action: 'strategy_approved', detail: { title: project.name, count: n }, at: now() })
  return n
}

export async function rejectProposal(db: DbOrTx, project: Project, proposal: StrategyRow, userId: string): Promise<void> {
  await db.update(schema.strategies).set({ status: 'verworfen', decidedAt: now(), decidedByUserId: userId }).where(eq(schema.strategies.id, proposal.id))
  await db.update(schema.experiments).set({ status: 'verworfen', decidedAt: now(), decidedByUserId: userId }).where(and(eq(schema.experiments.strategyId, proposal.id), eq(schema.experiments.status, 'vorschlag')))
  await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, actor: 'user', userId, action: 'strategy_rejected', detail: { title: project.name }, at: now() })
}

export interface ChannelStats {
  key: string
  planned: number
  done: number
  skipped: number
  rejected: number
  results: number
  resultMetrics: Record<string, number>
}

export async function channelStats(db: DbOrTx, projectId: string, from: string, to: string): Promise<Map<string, ChannelStats>> {
  const tasks = await db.select({ id: schema.tasks.id, key: schema.tasks.strategyChannel, status: schema.tasks.status, skipped: schema.tasks.skippedByPlan }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), isNotNull(schema.tasks.strategyChannel), sql`${schema.tasks.dueDate} between ${from} and ${to}`))
  const map = new Map<string, ChannelStats>()
  const get = (k: string) => {
    let s = map.get(k)
    if (!s) map.set(k, s = { key: k, planned: 0, done: 0, skipped: 0, rejected: 0, results: 0, resultMetrics: {} })
    return s
  }
  const keyOf = new Map<string, string>()
  for (const t of tasks) {
    const s = get(t.key!)
    keyOf.set(t.id, t.key!)
    if (t.skipped) {
      s.skipped++
      continue
    }
    if (t.status === 'verworfen') continue
    s.planned++
    if (countsAsDone(t.status)) s.done++
  }
  const ids = [...keyOf.keys()]
  if (ids.length) {
    const res = await db.select({ taskId: schema.results.taskId, metric: schema.results.metric, value: schema.results.value }).from(schema.results).where(inArray(schema.results.taskId, ids))
    for (const r of res) {
      const s = get(keyOf.get(r.taskId)!)
      s.results += r.value
      s.resultMetrics[r.metric] = (s.resultMetrics[r.metric] ?? 0) + r.value
    }
    const rej = await db.select({ taskId: schema.drafts.taskId }).from(schema.drafts).where(and(inArray(schema.drafts.taskId, ids), eq(schema.drafts.status, 'verworfen')))
    for (const r of rej) get(keyOf.get(r.taskId)!).rejected++
  }
  return map
}

export function ruleBasedChanges(channels: StrategyChannel[], stats: Map<string, ChannelStats>, strategyAgeDays: number): StrategyChange[] {
  const out: StrategyChange[] = []
  const withResults = channels.filter(c => c.active && (stats.get(c.key)?.done ?? 0) >= 2).map(c => ({ c, s: stats.get(c.key)!, rate: stats.get(c.key)!.results / Math.max(1, stats.get(c.key)!.done) }))
  const rates = withResults.map(x => x.rate).filter(r => r > 0).sort((a, b) => a - b)
  const median = rates.length ? rates[Math.floor(rates.length / 2)]! : 0
  for (const c of channels) {
    if (!c.active) continue
    const s = stats.get(c.key)
    if (!s) continue
    const rate = s.results / Math.max(1, s.done)
    if (s.done >= 2 && s.results > 0 && rate >= median && c.weight < MAX_WEIGHT) {
      out.push({ channelKey: c.key, name: c.name, change: 'more', from: c.weight, to: c.weight + 1, reason: `wirkt: ${fmt(s.results)} Ergebnisse aus ${s.done} Maßnahmen` })
      continue
    }
    if (s.done >= 3 && s.results === 0 && strategyAgeDays >= 21) {
      out.push(c.weight > 1
        ? { channelKey: c.key, name: c.name, change: 'less', from: c.weight, to: c.weight - 1, reason: `${s.done} Maßnahmen ohne messbares Ergebnis` }
        : { channelKey: c.key, name: c.name, change: 'pause', from: c.weight, to: c.weight, reason: `${s.done} Maßnahmen ohne messbares Ergebnis, schon auf kleinster Stufe` })
      continue
    }
    if (s.planned >= 3 && s.done / s.planned < 0.34 && c.weight > 1) {
      out.push({ channelKey: c.key, name: c.name, change: 'less', from: c.weight, to: c.weight - 1, reason: `nur ${s.done} von ${s.planned} Aufgaben erledigt, Takt zu hoch` })
    }
  }
  return out
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function emptyStrategyChannels(): StrategyChannel[] {
  return []
}

const START_WEIGHT: Record<string, number> = { community: 4, social: 5, content: 3, verzeichnis: 3, outreach: 1 }
const START_WHY: Record<string, string> = {
  community: 'Startwert 2x pro Woche: hilfreiche Antworten bringen interessierte Besucher',
  social: 'Startwert für regelmäßige Sichtbarkeit',
  content: 'Startwert 1x pro Woche: wirkt langfristig über Suche',
  verzeichnis: 'Startwert 1x pro Woche, bis die Liste abgearbeitet ist',
  outreach: 'Startwert 1x pro Monat: Presse und Partner',
  launch: 'Einzelne Launch-Termine aus dem Plan',
}

export async function connectExistingProject(db: DbOrTx, project: Project, from: string): Promise<StrategyRow | null> {
  if (await activeStrategy(db, project.id)) return null
  const any = await db.select({ id: schema.strategies.id }).from(schema.strategies).where(eq(schema.strategies.projectId, project.id)).limit(1)
  if (any.length) return null
  await db.update(schema.tasks).set({ strategyChannel: schema.tasks.category }).where(and(eq(schema.tasks.projectId, project.id), isNull(schema.tasks.strategyChannel), inArray(schema.tasks.category, [...STRATEGY_CATEGORIES])))
  const to = addDays(from, 83)
  const oneOff = await db.select({ cat: schema.tasks.category, n: sql<number>`count(*)::int` }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, project.id), isNull(schema.tasks.recurrenceId), sql`${schema.tasks.dueDate} between ${from} and ${to}`, inArray(schema.tasks.category, [...STRATEGY_CATEGORIES])))
    .groupBy(schema.tasks.category)
  const counts = new Map<string, number>(oneOff.map(c => [c.cat, c.n]))
  for (const p of await previewRecurrences(db, project.workspaceId, from, to, project.id)) counts.set(p.category, (counts.get(p.category) ?? 0) + 1)
  const goals = await db.select({ id: schema.goals.id }).from(schema.goals).where(eq(schema.goals.projectId, project.id))
  const channels: StrategyChannel[] = []
  for (const cat of STRATEGY_CATEGORIES) {
    const n = counts.get(cat) ?? 0
    if (!n && cat === 'launch') continue
    const base = Math.round((n / 12) * 100) / 100
    const start = cat === 'launch' ? Math.max(1, freqLevel(base)) : cat === 'social' && /musik|music|song|release/i.test(`${project.description ?? ''} ${project.name}`) ? 6 : START_WEIGHT[cat] ?? 3
    channels.push(normalizeChannel({ key: cat, name: CHANNEL_LABELS[cat]!, category: cat, why: START_WHY[cat] ?? 'Startwert', goalIds: goals.map(g => g.id), weight: start, base, active: true }))
  }
  const s = await createStrategyVersion(db, project, { channels, summary: 'Startstrategie aus MARKETINGPLAN.md', status: 'aktiv', kind: 'initial', byAgent: false })
  await db.update(schema.strategies).set({ decidedAt: now() }).where(eq(schema.strategies.id, s.id))
  return s
}

export function channelsForGoals(channels: StrategyChannel[], goalId: string): StrategyChannel[] {
  return channels.filter(c => c.goalIds.includes(goalId))
}

export async function hasOpenProposal(db: DbOrTx, projectId: string): Promise<boolean> {
  return !!(await pendingProposal(db, projectId))
}

export async function strategyHistory(db: DbOrTx, projectId: string, limit = 12): Promise<StrategyRow[]> {
  return db.select().from(schema.strategies).where(and(eq(schema.strategies.projectId, projectId), inArray(schema.strategies.status, ['aktiv', 'abgeloest', 'verworfen']))).orderBy(desc(schema.strategies.version)).limit(limit)
}
