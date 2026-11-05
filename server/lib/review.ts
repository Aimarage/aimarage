import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { addDays, diffDays } from '../../shared/utils/dates'
import { clampWeight, STRATEGY_CATEGORIES, WEIGHT_PER_WEEK } from '../../shared/utils/plan'
import type { StrategyChange } from '../db/schema'
import { reviewPrompt, SYSTEM, withRules } from '../prompts/de'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { listGoals } from './goals'
import { chatJson, llmStatus, type ChatResult, type LlmConfig } from './llm'
import { trafficDigest } from './traffic'
import { seoDigest } from './search-console'
import { geoDigest } from './geo'
import { applyBestTimes, bestTimesDigest, proposeEvergreen } from './best-times'
import { experimentStep, insightsDigest, recordWeeks } from './experiments'
import { autoStrategyOn, autoText, recordAuto, splitAuto, strategyEvidence, undoneKeys } from './auto-strategy'
import { proposeReleaseStrategy, releaseFocusFor, staleStrategy } from './release-focus'
import { releaseRule } from '../../shared/utils/release-focus'
import { activeStrategy, applyChanges, applyStrategy, changeStrategy, channelKey, channelStats, createStrategyVersion, enqueueReconcile, normalizeChannel, pendingProposal, ruleBasedChanges } from './strategy'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const llmReviewSchema = z.object({
  summary: z.string().catch(''),
  changes: z.array(z.object({ channelKey: z.string(), change: z.enum(['more', 'less', 'pause', 'resume']), reason: z.string().catch('') })).catch([]),
  newChannels: z.array(z.object({ name: z.string().min(1), category: z.string().catch('social'), why: z.string().catch(''), weight: z.number().catch(3), places: z.array(z.string()).catch([]), topics: z.array(z.string()).catch([]) })).catch([]),
  details: z.array(z.object({ channelKey: z.string(), places: z.array(z.string()).optional(), topics: z.array(z.string()).optional() })).catch([]),
})

export interface ReviewResult {
  applied: StrategyChange[]
  proposed: StrategyChange[]
  summary: string
  created: number
}

export async function reviewProject(db: Db, ws: Workspace, project: Project, deps: { llm: LlmConfig | null, llmFetch?: FetchLike, usage?: ChatResult[], log?: string[] } = { llm: null }): Promise<ReviewResult | null> {
  const strat = await activeStrategy(db, project.id)
  if (!strat) return null
  const d = today(ws.timezone)
  const from = addDays(d, -28)
  await recordWeeks(db, ws, project, d)
  const stats = await channelStats(db, project.id, from, d)
  const age = diffDays(d, (strat.decidedAt ?? strat.createdAt).toISOString().slice(0, 10))
  const firstAt = (await db.select({ c: schema.strategies.createdAt }).from(schema.strategies).where(eq(schema.strategies.projectId, project.id)).orderBy(schema.strategies.version).limit(1))[0]?.c
  const totalAge = firstAt ? diffDays(d, firstAt.toISOString().slice(0, 10)) : age
  let changes = ruleBasedChanges(strat.channels, stats, totalAge)
  const focus = await releaseFocusFor(db, project.id, d)
  const goals = await listGoals(db, ws.id, d, { projectId: project.id })
  let summary = ''
  let details: { channelKey: string, places?: string[], topics?: string[] }[] = []
  const anyDone = [...stats.values()].some(x => x.done > 0)
  if (deps.llm && llmStatus(deps.llm).configured && anyDone && totalAge >= 7) {
    try {
      const traffic = [await trafficDigest(db, project, from, addDays(d, -1)), await seoDigest(db, project, d), await geoDigest(db, project.id), await bestTimesDigest(db, ws, project), await insightsDigest(db, project.id)].filter(Boolean).join('\n\n')
      const prompt = reviewPrompt({
        traffic,
        name: project.name,
        goals: goals.map(g => `${g.label}: ${g.progress.current} von ${g.targetValue ?? '?'}${g.deadline ? ` bis ${g.deadline}` : ''} (${g.progress.pct} %, erwartet ${g.progress.expectedPct ?? '?'} %)`),
        channels: strat.channels.map((c) => {
          const s = stats.get(c.key)
          return `${c.key} "${c.name}" ${c.active ? `Stufe ${c.weight}` : 'pausiert'}${c.places?.length ? ` [Orte: ${c.places.join(', ')}]` : ''}${c.topics?.length ? ` [Themen: ${c.topics.join(', ')}]` : ''}: ${s?.planned ?? 0} geplant, ${s?.done ?? 0} erledigt, ${s?.rejected ?? 0} Entwürfe verworfen, Ergebnisse ${JSON.stringify(s?.resultMetrics ?? {})}`
        }),
        proposed: changes.map(c => `${c.channelKey}: ${c.change} (${c.reason})`),
        release: releaseRule(focus),
      })
      deps.log?.push(prompt)
      const { data, usage } = await chatJson(deps.llm, { maxTokens: 1500, messages: [{ role: 'system', content: withRules(SYSTEM, project.rules) }, { role: 'user', content: prompt }] }, llmReviewSchema, deps.llmFetch)
      deps.usage?.push(...usage)
      summary = data.summary.replace(/[–—]/g, '-')
      const byKey = new Map(strat.channels.map(c => [c.key, c]))
      const merged: StrategyChange[] = []
      for (const ch of data.changes) {
        const c = byKey.get(ch.channelKey)
        if (!c) continue
        if (ch.change === 'resume' && c.active) continue
        if (ch.change === 'pause' && !c.active) continue
        const to = ch.change === 'more' ? clampWeight(c.weight + 1) : ch.change === 'less' ? clampWeight(c.weight - 1) : c.weight
        if ((ch.change === 'more' || ch.change === 'less') && to === c.weight) continue
        const rule = changes.find(x => x.channelKey === c.key)
        merged.push({ channelKey: c.key, name: c.name, change: ch.change, from: c.weight, to, reason: (ch.reason || rule?.reason || '').replace(/[–—]/g, '-').slice(0, 200) })
      }
      for (const n of data.newChannels.slice(0, 2)) {
        const key = channelKey(n.name)
        if (byKey.has(key)) continue
        const channel = normalizeChannel({ name: n.name, category: (STRATEGY_CATEGORIES as readonly string[]).includes(n.category) ? n.category : 'social', why: n.why, weight: n.weight, goalIds: goals.map(g => g.id), places: n.places, topics: n.topics })
        merged.push({ channelKey: channel.key, name: channel.name, change: 'new', from: null, to: channel.weight, reason: n.why.slice(0, 200), channel })
      }
      changes = merged
      details = data.details.filter(x => byKey.has(x.channelKey))
    }
    catch (err) {
      deps.log?.push(`LLM-Review: ${(err as Error).message}, regelbasiert weiter`)
    }
  }
  if (details.length) {
    const cur = (await activeStrategy(db, project.id))!
    const channels = cur.channels.map((c) => {
      const x = details.find(dd => dd.channelKey === c.key)
      return x ? normalizeChannel({ ...c, places: x.places ?? c.places, topics: x.topics ?? c.topics }) : c
    })
    await db.update(schema.strategies).set({ channels }).where(eq(schema.strategies.id, cur.id))
  }
  const timed = await applyBestTimes(db, ws, project)
  const evidence = await strategyEvidence(db, project, from, addDays(d, -1), stats)
  const { auto: small, proposal: big } = splitAuto(changes, { on: autoStrategyOn(ws), enough: evidence.enough, blocked: await undoneKeys(db, project.id) })
  let created = 0
  if (small.length) {
    const before = (await activeStrategy(db, project.id))!.channels
    const res = await changeStrategy(db, project, small, d, { kind: 'review', byAgent: true, summary: summary || null })
    created = res.created
    await recordAuto(db, project, res.strategy.id, small, before)
  }
  else {
    created = await applyStrategy(db, project, timed.length ? (await activeStrategy(db, project.id))! : strat, d)
  }
  let proposed: StrategyChange[] = []
  if (big.length) {
    const pending = await pendingProposal(db, project.id)
    if (pending && pending.kind === 'review') await db.update(schema.strategies).set({ status: 'verworfen' }).where(eq(schema.strategies.id, pending.id))
    if (!pending || pending.kind === 'review') {
      const cur = (await activeStrategy(db, project.id))!
      await createStrategyVersion(db, project, { channels: applyChanges(cur.channels, big), changes: big, summary: summary || null, status: 'vorschlag', kind: 'review', byAgent: true })
      for (const ch of big) await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'strategy_proposed_change', detail: { title: ch.name, change: ch.change, reason: ch.reason }, at: now() })
      proposed = big
    }
  }
  for (const c of strat.channels) {
    const s = stats.get(c.key)
    if (s && s.done >= 2 && s.results > 0) await db.insert(schema.projectMemory).values({ projectId: project.id, kind: 'erfahrung', text: `${d}: ${c.name} brachte ${s.results} Ergebnisse aus ${s.done} Maßnahmen (4 Wochen)` })
  }
  const text = summary || (!anyDone && !changes.length ? `Noch keine erledigten Maßnahmen zum Auswerten. Plan fortgeschrieben: ${created} neue Termine.` : '') || [
    small.length ? `${autoText(small, 'de')}.` : 'Keine Anpassungen nötig.',
    big.length ? `Vorschlag zur Freigabe: ${big.length} Änderung${big.length > 1 ? 'en' : ''}${evidence.enough ? '' : ' (noch zu wenig Daten)'}.` : '',
    `Plan fortgeschrieben: ${created} neue Termine.`,
  ].filter(Boolean).join(' ')
  const stale = focus ? await staleStrategy(db, project, d) : null
  const releaseProposal = stale && focus && !proposed.length ? await proposeReleaseStrategy(db, ws, project, focus, 'stale') : null
  if (stale) await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'strategy_stale', detail: { title: project.name, text: stale.text }, at: now() })
  const ever = await proposeEvergreen(db, ws, project, { draft: !!deps.llm && llmStatus(deps.llm).configured })
  const exp = await experimentStep(db, ws, project, d)
  const full = [stale ? `${stale.text}${releaseProposal ? ' Vorschlag zur Freigabe liegt bereit.' : ' Vorschlag: Neu denken.'}` : '', text, timed.length ? `Beste Zeiten übernommen: ${timed.join('; ')}.` : '', ever ? `Neu aufzulegen vorgeschlagen: ${ever.title} (${ever.code}).` : '', ...exp].filter(Boolean).join(' ')
  const after = await activeStrategy(db, project.id)
  if (after) await enqueueReconcile(db, project, after.id, d)
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'strategy_reviewed', detail: { title: project.name, count: small.length + proposed.length, text: full }, at: now() })
  return { applied: small, proposed, summary: full, created }
}

export async function reviewAll(db: Db, ws: Workspace, deps: { llm: LlmConfig | null, llmFetch?: FetchLike, usage?: ChatResult[], log?: string[] }): Promise<{ projects: number, applied: number, proposed: number }> {
  const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))
  let n = 0
  let applied = 0
  let proposed = 0
  for (const p of projects) {
    const r = await reviewProject(db, ws, p, deps)
    if (!r) continue
    n++
    applied += r.applied.length
    proposed += r.proposed.length
  }
  return { projects: n, applied, proposed }
}

export function perWeekLabel(weight: number): number {
  return WEIGHT_PER_WEEK[weight] ?? 1
}
