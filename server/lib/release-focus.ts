import { and, asc, desc, eq, gte, inArray, isNotNull, like, or, sql } from 'drizzle-orm'
import { RELEASE_KIND_LABEL, RELEASE_KINDS, validDate, type ReleaseKind } from '../../shared/utils/release'
import { mentionsCurrent, oldReleaseHit, oldReleaseHits, RELEASE_CHECK, releaseFocus, releaseHitText, releaseLabel, strategyStale, type KnownRelease, type ReleaseFocus } from '../../shared/utils/release-focus'
import type { StrategyChannel } from '../db/schema'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { activeStrategy, createStrategyVersion, pendingProposal, type StrategyRow } from './strategy'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

const GOAL_RE = /^(\S+) (.+), Release (\d{4}-\d{2}-\d{2})$/
const CONTENT_CATEGORIES = ['social', 'content', 'community', 'outreach']

function kindOf(work: string): ReleaseKind {
  const hit = RELEASE_KINDS.find(k => RELEASE_KIND_LABEL[k].work.toLowerCase() === work.toLowerCase())
  return hit ?? 'album'
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function knownReleases(db: DbOrTx, projectId: string): Promise<KnownRelease[]> {
  const rows = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.projectId, projectId), or(isNotNull(schema.campaigns.release), like(schema.campaigns.name, 'Release:%')))).orderBy(asc(schema.campaigns.createdAt))
  const out: KnownRelease[] = []
  for (const c of rows) {
    if (c.release?.title && validDate(c.release.releaseDate)) {
      out.push({ title: c.release.title, kind: c.release.kind, releaseDate: c.release.releaseDate, items: c.release.items ?? [] })
      continue
    }
    const m = GOAL_RE.exec(c.goal ?? '')
    if (!m || !validDate(m[3])) continue
    const title = c.name.replace(/^Release:\s*/, '').trim() || m[2]!
    const series = new RegExp(`^${escapeRe(title)}-Serie \\d+/\\d+: (.+)$`)
    const tasks = await db.select({ title: schema.tasks.title }).from(schema.tasks).where(eq(schema.tasks.campaignId, c.id)).orderBy(asc(schema.tasks.dueDate))
    const items = tasks.map(t => series.exec(t.title)?.[1]?.trim() ?? '').filter(t => t && !/^das ganze /i.test(t))
    out.push({ title, kind: kindOf(m[1]!), releaseDate: m[3]!, items: [...new Set(items)] })
  }
  return out
}

export async function releaseFocusFor(db: DbOrTx, projectId: string, day: string): Promise<ReleaseFocus | null> {
  return releaseFocus(await knownReleases(db, projectId), day)
}

export async function releaseExempt(db: DbOrTx, task: { id: string, releaseOk: boolean }, focus: ReleaseFocus | null): Promise<boolean> {
  if (task.releaseOk) return true
  if (!focus?.older.length) return false
  const notes = await db.select({ text: schema.taskNotes.text }).from(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, task.id), eq(schema.taskNotes.byAgent, false)))
  return notes.some(n => oldReleaseHits(n.text, focus).length > 0)
}

function dmy(d: string): string {
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`
}

export function releaseTopic(r: KnownRelease): string {
  const { work, item } = RELEASE_KIND_LABEL[r.kind] ?? { work: 'Release', item: 'Track' }
  const n = r.items.length
  return `${work} "${r.title}" (Release ${dmy(r.releaseDate)}): ${n ? `${n} ${n === 1 ? item : `${item}s`} vorstellen, ` : ''}${work} first`.slice(0, 140)
}

export function strategyTexts(st: Pick<StrategyRow, 'summary' | 'channels'>): string[] {
  return [st.summary ?? '', ...st.channels.flatMap(c => [c.name, c.why, ...(c.places ?? []), ...(c.topics ?? [])])]
}

export function releaseChannels(channels: StrategyChannel[], focus: ReleaseFocus): { channels: StrategyChannel[], removed: string[] } {
  const removed: string[] = []
  const topic = releaseTopic(focus.current)
  const out = channels.map((c) => {
    const topics = c.topics ?? []
    const kept = topics.filter(t => mentionsCurrent(t, focus) || !oldReleaseHits(t, focus).length)
    for (const t of topics) if (!kept.includes(t) && !removed.includes(t)) removed.push(t)
    if (!c.active || !CONTENT_CATEGORIES.includes(c.category)) return kept.length === topics.length ? c : { ...c, topics: kept }
    return { ...c, topics: [topic, ...kept.filter(t => !mentionsCurrent(t, focus))].slice(0, 6) }
  })
  return { channels: out, removed }
}

async function rejectedFor(db: DbOrTx, projectId: string, title: string): Promise<boolean> {
  const [r] = await db.select({ id: schema.strategies.id }).from(schema.strategies).where(and(eq(schema.strategies.projectId, projectId), eq(schema.strategies.kind, 'release'), eq(schema.strategies.status, 'verworfen'), isNotNull(schema.strategies.decidedAt), like(schema.strategies.summary, `%"${title.replace(/[%_]/g, '')}"%`))).limit(1)
  return !!r
}

export async function proposeReleaseStrategy(db: DbOrTx, ws: Workspace, project: Project, focus: ReleaseFocus, reason: 'release' | 'stale'): Promise<StrategyRow | null> {
  if (ws.settings?.agentEnabled === false) return null
  const cur = await activeStrategy(db, project.id)
  if (!cur || mentionsCurrent(strategyTexts(cur).join('\n'), focus)) return null
  const tag = `"${focus.current.title}"`
  const pending = await pendingProposal(db, project.id)
  if (pending?.kind === 'release' && pending.summary?.includes(tag)) return pending
  if (pending && pending.kind !== 'review' && pending.kind !== 'release') return null
  if (await rejectedFor(db, project.id, focus.current.title)) return null
  const { channels, removed } = releaseChannels(cur.channels, focus)
  const label = releaseLabel(focus.current)
  const since = focus.current.releaseDate > today(ws.timezone) ? 'ab' : 'seit'
  const summary = [
    reason === 'release' ? `Neues Release: ${label.replace(/ \(/, ` ${since} `).replace(/\)$/, '')}.` : `Strategie veraltet: Das aktuelle Release ${label} fehlt.`,
    'Themen der Kanäle auf das aktuelle Release umgestellt.',
    removed.length ? `Entfernt (älteres Release): ${removed.slice(0, 4).join('; ')}.` : '',
    'Ältere Releases nur noch, wenn eine Aufgabe oder du sie ausdrücklich nennst.',
  ].filter(Boolean).join(' ')
  if (pending) await db.update(schema.strategies).set({ status: 'verworfen' }).where(eq(schema.strategies.id, pending.id))
  const row = await createStrategyVersion(db, project, { channels, changes: [], summary, status: 'vorschlag', kind: 'release', byAgent: true })
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'strategy_proposed', detail: { title: project.name, count: channels.length }, at: now() })
  return row
}

export async function flagOldReleaseTasks(db: DbOrTx, ws: Workspace, project: Project, focus: ReleaseFocus, from: string): Promise<number> {
  if (!focus.older.length) return 0
  const tasks = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.projectId, project.id),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig']),
    isNotNull(schema.tasks.agentStep),
    eq(schema.tasks.releaseOk, false),
    gte(schema.tasks.dueDate, from),
  ))
  if (!tasks.length) return 0
  const ids = tasks.map(t => t.id)
  const drafts = await db.select({ taskId: schema.drafts.taskId, subject: schema.drafts.subject, body: schema.drafts.body }).from(schema.drafts).where(and(inArray(schema.drafts.taskId, ids), eq(schema.drafts.status, 'offen')))
  const flagged = new Set((await db.select({ taskId: schema.taskNotes.taskId }).from(schema.taskNotes).where(and(inArray(schema.taskNotes.taskId, ids), like(schema.taskNotes.text, `${RELEASE_CHECK}%`)))).map(n => n.taskId))
  let n = 0
  for (const t of tasks) {
    const text = [t.title, t.description ?? '', ...drafts.filter(d => d.taskId === t.id).flatMap(d => [d.subject ?? '', d.body])].join('\n')
    const hit = oldReleaseHit(text, focus)
    if (!hit) continue
    n++
    if (flagged.has(t.id)) continue
    await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: true, text: `${RELEASE_CHECK} Seit ${dmy(focus.current.releaseDate)} ist ${releaseLabel(focus.current)} das aktuelle Release, diese Aufgabe nennt ${releaseHitText(hit, focus).replace(/, aktuell: .*$/, '')}. Bitte prüfen: verwerfen, auf das aktuelle Release umschreiben oder bewusst behalten (dann in einer Notiz das ältere Release nennen).`, createdAt: now() })
  }
  if (n) await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'release_tasks_flagged', detail: { title: focus.current.title, count: n }, at: now() })
  return n
}

export async function onReleaseCreated(db: DbOrTx, ws: Workspace, project: Project, release: KnownRelease): Promise<{ flagged: number, proposalId: string | null }> {
  const d = today(ws.timezone)
  const day = release.releaseDate > d ? release.releaseDate : d
  const focus = releaseFocus(await knownReleases(db, project.id), day)
  if (!focus || focus.current.title !== release.title) return { flagged: 0, proposalId: null }
  const flagged = await flagOldReleaseTasks(db, ws, project, focus, day)
  const proposal = await proposeReleaseStrategy(db, ws, project, focus, 'release')
  return { flagged, proposalId: proposal?.id ?? null }
}

export interface StaleStrategy {
  projectId: string
  projectName: string
  slug: string
  release: string
  label: string
  reason: 'old' | 'before'
  old: string | null
  text: string
  proposalId: string | null
}

export async function staleStrategy(db: DbOrTx, project: Project, day: string): Promise<StaleStrategy | null> {
  const st = await activeStrategy(db, project.id)
  if (!st) return null
  const focus = await releaseFocusFor(db, project.id, day)
  if (!focus) return null
  const [base] = await db.select({ decidedAt: schema.strategies.decidedAt, createdAt: schema.strategies.createdAt }).from(schema.strategies).where(and(eq(schema.strategies.projectId, project.id), inArray(schema.strategies.status, ['aktiv', 'abgeloest']), sql`${schema.strategies.kind} <> 'review'`)).orderBy(desc(schema.strategies.version)).limit(1)
  const decided = ((base ?? st).decidedAt ?? (base ?? st).createdAt).toISOString().slice(0, 10)
  const stale = strategyStale(strategyTexts(st), focus, decided)
  if (!stale || await rejectedFor(db, project.id, focus.current.title)) return null
  const pending = await pendingProposal(db, project.id)
  const label = releaseLabel(focus.current)
  const old = stale.reason === 'old' ? (stale.hit.term === stale.hit.release.title ? releaseLabel(stale.hit.release) : `"${stale.hit.term}", ${releaseLabel(stale.hit.release)}`) : null
  const text = old
    ? `Strategie veraltet: Sie nennt ${old}, das aktuelle Release ${label} fehlt.`
    : `Strategie veraltet: Sie wurde vor dem aktuellen Release ${label} freigegeben und nennt es nicht.`
  return { projectId: project.id, projectName: project.name, slug: project.slug, release: focus.current.title, label, reason: stale.reason, old, text, proposalId: pending?.kind === 'release' ? pending.id : null }
}

export async function staleStrategies(db: DbOrTx, ws: Workspace, projectIds?: string[]): Promise<StaleStrategy[]> {
  const d = today(ws.timezone)
  const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), sql`${schema.projects.archivedAt} is null`, projectIds ? (projectIds.length ? inArray(schema.projects.id, projectIds) : sql`false`) : undefined)).orderBy(desc(schema.projects.createdAt))
  const out: StaleStrategy[] = []
  for (const p of projects) {
    const s = await staleStrategy(db, p, d)
    if (s) out.push(s)
  }
  return out
}
