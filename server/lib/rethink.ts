import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { addDays, diffDays, isValidIso, isValidTime, weekday } from '../../shared/utils/dates'
import type { Category } from '../../shared/utils/domain'
import { CATEGORY_DRAFT, CATEGORY_STEPS, STRATEGY_CATEGORIES } from '../../shared/utils/plan'
import { fixOwnDomain } from '../../shared/utils/own-domain'
import type { RethinkPlan, StrategyChange, StrategyChannel } from '../db/schema'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import type { ChatResult, LlmConfig } from './llm'
import { isPlanRecurrence } from './materialize'
import { analyzeProject } from './onboarding'
import { planAllowsMail } from '../../shared/utils/coldmail'
import { duplicateOf, ensureSetupTask, humanRejected, isExcluded, knownTasks, planGuard, projectMemoryTexts, rejectedTopicOf, taskBlock } from './plan-guard'
import { isBlindReply } from '../../shared/utils/community-sweep'
import { parsePlan, PRODUCT_CODES } from './plan-import'
import { activateStrategy, activeStrategy, logDropped, projectOwner, projectSite, type StrategyRow } from './strategy'
import { createTask } from './tasks'
import { trafficDigest } from './traffic'
import { doneDigest, isListingUpdate, listingConflict, listingDigest, listingRegister, openListings, taskDirectories } from './listings'
import { seoDigest } from './search-console'
import { geoDigest } from './geo'
import { docsContext } from './documents'
import { insightsDigest } from './experiments'
import { knownReleases } from './release-focus'
import { oldReleaseHit, releaseFocus } from '../../shared/utils/release-focus'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const PLAN_DAYS = 21
export const RETHINK_DROP = 'Verworfen beim Neu-Denken:'

export interface RethinkDeps {
  llm: LlmConfig | null
  llmFetch?: FetchLike
  webFetch?: FetchLike
  usage?: ChatResult[]
  log?: string[]
  userId?: string | null
  planFile?: string
  reason?: string | null
}

export interface RethinkResult {
  version: number
  summary: string
  channels: number
  planned: number
  proposalId: string
}

export function planKnowledge(md: string, code: string): string {
  const plan = parsePlan(md)
  const lines: string[] = []
  const goals = plan.goals.filter(g => g.product === code)
  if (goals.length) lines.push(`Ziele laut Plan: ${goals.map(g => `${g.label} ${g.target3m} in 3 Monaten`).join('; ')}`)
  const p0 = plan.phase0.filter(p => p.product === code)
  if (p0.length) lines.push(`Fundament-Aufgaben: ${p0.map(p => p.title).join('; ')}`)
  const groups = new Map<string, string[]>()
  for (const c of plan.channels.filter(c => c.product === code)) groups.set(c.group, [...(groups.get(c.group) ?? []), c.name])
  for (const [g, names] of groups) lines.push(`${g}: ${names.join('; ')}`)
  const backlog = plan.backlog.filter(b => b.product === code && b.prio !== 'P3')
  if (backlog.length) lines.push(`Content-Ideen: ${backlog.map(b => `${b.title} (${b.language})`).join('; ')}`)
  const weeks = plan.weeks.filter(w => w.focus === code && w.highlight)
  if (weeks.length) lines.push(`Geplante Höhepunkte: ${weeks.map(w => `${w.date}: ${w.highlight}`).join('; ')}`)
  return lines.join('\n')
}

function readPlanFile(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }
  catch {
    return null
  }
}

function channelText(c: StrategyChannel): string {
  return `${c.name} (${c.category}, Stufe ${c.weight}${c.active ? '' : ', pausiert'})${c.places?.length ? `: ${c.places.join(', ')}` : ''}`
}

export function diffChannels(before: StrategyChannel[], after: StrategyChannel[]): StrategyChange[] {
  const out: StrategyChange[] = []
  for (const c of after) {
    const old = before.find(b => b.key === c.key || b.category === c.category && b.name === c.name)
    if (!old) out.push({ channelKey: c.key, name: c.name, change: 'new', from: null, to: c.weight, reason: c.why.slice(0, 200) })
    else if (!old.active && c.active) out.push({ channelKey: c.key, name: c.name, change: 'resume', from: old.weight, to: c.weight, reason: c.why.slice(0, 200) })
    else if (old.weight !== c.weight) out.push({ channelKey: c.key, name: c.name, change: c.weight > old.weight ? 'more' : 'less', from: old.weight, to: c.weight, reason: c.why.slice(0, 200) })
  }
  for (const b of before) {
    if (!after.some(c => c.key === b.key || c.category === b.category && c.name === b.name)) out.push({ channelKey: b.key, name: b.name, change: 'remove', from: b.weight, to: null, reason: 'Neu gedacht, ersetzt durch die neuen Kanäle' })
  }
  return out
}

function workday(d: string): string {
  const w = weekday(d)
  return w === 6 ? addDays(d, 2) : w === 7 ? addDays(d, 1) : d
}

export async function rethinkStrategy(db: Db, ws: Workspace, project: Project, deps: RethinkDeps): Promise<RethinkResult> {
  const d = today(ws.timezone)
  const from = workday(addDays(d, 1))
  const to = addDays(from, PLAN_DAYS - 1)
  const current = await activeStrategy(db, project.id)
  const md = readPlanFile(deps.planFile ?? resolve(process.env.PLAN_FILE || './MARKETINGPLAN.md'))
  const code = Object.values(PRODUCT_CODES).includes(project.code) ? project.code : PRODUCT_CODES[project.slug] ?? null
  const memory = await db.select({ text: schema.projectMemory.text }).from(schema.projectMemory).where(eq(schema.projectMemory.projectId, project.id)).orderBy(desc(schema.projectMemory.createdAt)).limit(15)
  const traffic = await trafficDigest(db, project, addDays(d, -28), addDays(d, -1))
  const seo = await seoDigest(db, project, d)
  const geo = await geoDigest(db, project.id)
  const insights = await insightsDigest(db, project.id)
  const rejected = await humanRejected(db, project.id)
  const docs = await docsContext(db, project.id, [project.description ?? '', project.setup?.analysis?.positioning ?? '', ...(project.setup?.analysis?.audiences ?? [])].join('\n'), 3000)
  const listed = listingDigest(await listingRegister(db, project), project.name)
  const done = await doneDigest(db, project.id)
  const knowledge = [
    project.description ? `Beschreibung: ${project.description}` : '',
    traffic ? `${traffic}\nRichte die Kanäle danach aus, welche Quellen wirklich Anmeldungen und Käufe bringen.` : '',
    seo ? `${seo}\nGibt es einen Content-Kanal, trage Chancen-Begriffe als Ratgeber-Themen (topics) ein.` : '',
    geo ? `${geo}\nPlane Inhalte und Verzeichnis-Einträge so, dass sie diese Käuferfragen beantworten.` : '',
    docs.length ? `Unterlagen des Projekts:\n${docs.map(d => `- ${d}`).join('\n')}` : '',
    memory.length ? `Notizen:\n${memory.map(m => `- ${m.text}`).join('\n')}` : '',
    done,
    listed ? `${listed}\nVerzeichnisse sind einmalige Einträge, keine Dauerschiene: je Verzeichnis höchstens eine Aufgabe, und nur Verzeichnisse planen, die noch nicht im Register stehen. Ist die Liste abgearbeitet, den Verzeichnis-Kanal pausieren und die Zeit in andere Kanäle stecken.` : '',
    rejected.length ? `Vom Menschen verworfen (diese Themen nicht wieder planen):\n${rejected.slice(0, 30).map(r => `- ${r.title}`).join('\n')}` : '',
    'Community-Antworten nicht als Aufgaben planen: Die legt der Agent nur zu echten, aktuellen Threads an, in denen unser Produkt oder Wissen das Problem der Person löst.',
    insights,
    md && code ? planKnowledge(md, code) : '',
  ].filter(Boolean).join('\n')

  const strategyCats = [...STRATEGY_CATEGORIES] as Category[]
  const planned = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.projectId, project.id),
    isNull(schema.tasks.recurrenceId),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']),
    gte(schema.tasks.dueDate, addDays(d, -14)),
    lte(schema.tasks.dueDate, addDays(d, 70)),
    inArray(schema.tasks.category, strategyCats),
  )).orderBy(schema.tasks.dueDate).limit(60)

  const reason = deps.reason?.replace(/[\u2013\u2014]/g, '-').trim().slice(0, 1000) || null
  const r = await analyzeProject(db, ws, project, {
    llm: deps.llm,
    llmFetch: deps.llmFetch,
    webFetch: deps.webFetch,
    usage: deps.usage,
    log: deps.log,
    rethink: { knowledge, reason, current: current ? current.channels.map(channelText).join('\n') : null, planned: planned.map(t => `${t.code}, ${t.dueDate}, ${t.title}${t.status !== 'geplant' ? ' (Entwurf fertig, bleibt)' : ''}`), from, to },
  })
  const plan = r.plan!
  const changes = diffChannels(current?.channels ?? [], r.proposal.channels)
  const summary = [reason ? `Anlass: ${reason.slice(0, 300)}` : '', r.proposal.summary ?? ''].filter(Boolean).join(' ')
  await db.update(schema.strategies).set({ changes, summary }).where(eq(schema.strategies.id, r.proposal.id))
  const tasks: RethinkPlan['tasks'] = plan.tasks.flatMap(t => t && isValidIso(t.date) ? [t] : []).slice(0, 30).map(t => ({ date: t.date, time: t.time ?? null, channel: t.channel, title: t.title, place: t.place ?? null, brief: t.brief ?? null }))
  const drop = plan.drop.filter(c => planned.some(t => t.code === c && t.status === 'geplant'))
  const [p0] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, project.id))
  await db.update(schema.projects).set({ setup: { ...p0!.setup, state: p0!.setup.state === 'onboarding' ? 'onboarding' : 'ready', progress: undefined, rethinkPlan: { strategyId: r.proposal.id, from, to, tasks, drop } } }).where(eq(schema.projects.id, project.id))
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'strategy_rethought', detail: { title: project.name, version: r.proposal.version, tasks: tasks.length, proposal: true, text: summary }, at: now() })
  return { version: r.proposal.version, summary, channels: r.proposal.channels.length, planned: tasks.length, proposalId: r.proposal.id }
}

// Beim Freigeben eines Neu-denken-Vorschlags: geplante Aufgaben anlegen (ohne Doppel), alten Plan behutsam ablösen.
// Inhalte und Aufgaben mit Entwurf bleiben, der Abgleich (reconcile) prüft sie danach gegen die neue Strategie.
export async function applyRethinkPlan(db: DbOrTx, project: Project, proposal: StrategyRow, d: string, userId: string | null, log?: string[]): Promise<{ created: number, dropped: number, materialized: number }> {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, project.workspaceId))
  const [p0] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id))
  const stored = p0!.setup.rethinkPlan?.strategyId === proposal.id ? p0!.setup.rethinkPlan : null
  const from = workday(addDays(d, 1))
  const shift = stored && stored.from < from ? diffDays(from, stored.from) : 0
  const to = stored ? addDays(stored.to, shift) : addDays(from, PLAN_DAYS - 1)
  await db.update(schema.projects).set({ setup: { ...p0!.setup, state: 'ready', plan: 'agent', progress: undefined, rethinkPlan: null } }).where(eq(schema.projects.id, project.id))
  const proj = { ...p0!, setup: { ...p0!.setup, plan: 'agent' as const, rethinkPlan: null } }

  const planRecs = (await db.select().from(schema.recurrences).where(eq(schema.recurrences.workspaceId, project.workspaceId))).filter(isPlanRecurrence).map(x => x.id)
  let dropped = 0
  if (planRecs.length) {
    const del = await db.delete(schema.tasks).where(and(
      eq(schema.tasks.projectId, project.id),
      inArray(schema.tasks.recurrenceId, planRecs),
      eq(schema.tasks.status, 'geplant'),
      gte(schema.tasks.dueDate, d),
      sql`${schema.tasks.category} <> 'content'`,
      sql`not exists (select 1 from drafts where drafts.task_id = ${schema.tasks.id})`,
    )).returning({ id: schema.tasks.id, code: schema.tasks.code })
    dropped += del.length
    await logDropped(db, project, del.map(t => t.code), 'rethink')
  }
  if (stored?.drop.length) {
    const upd = await db.update(schema.tasks).set({ status: 'verworfen', updatedAt: now() }).where(and(
      eq(schema.tasks.projectId, project.id),
      inArray(schema.tasks.code, stored.drop),
      eq(schema.tasks.status, 'geplant'),
      sql`${schema.tasks.category} <> 'content'`,
      sql`${schema.tasks.draftKind} is distinct from 'article'`,
      isNull(schema.tasks.createdByUserId),
      sql`not exists (select 1 from drafts where drafts.task_id = ${schema.tasks.id})`,
    )).returning({ id: schema.tasks.id, title: schema.tasks.title })
    for (const t of upd) {
      await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: true, text: `${RETHINK_DROP} Die neue Strategie (v${proposal.version}) sieht diese Aufgabe nicht mehr vor. Zurückholen: Status auf "geplant" setzen.`, createdAt: now() })
      await logActivity(db, { workspaceId: project.workspaceId, projectId: project.id, taskId: t.id, actor: 'agent', action: 'status:verworfen', detail: { title: t.title, reason: 'rethink', version: proposal.version }, at: now() })
    }
    dropped += upd.length
  }

  const owner = await projectOwner(db, project.id)
  const channels = proposal.channels
  const findChannel = (name: string) => {
    const n = name.trim().toLowerCase()
    return channels.find(c => c.name.toLowerCase() === n || c.key === n) ?? channels.find(c => n && (c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase())))
  }
  const taskIds: string[] = []
  const guard = planGuard(ws!, proj, await projectMemoryTexts(db, project.id))
  const known = await knownTasks(db, project.id)
  const releases = await knownReleases(db, project.id)
  const rejected = await humanRejected(db, project.id)
  const register = await listingRegister(db, project)
  const openDirs = await openListings(db, project)
  let listedDup = 0
  let oldRelease = 0
  let blind = 0
  let declined = 0
  let blocked = 0
  let skipped = 0
  for (const t of stored?.tasks ?? []) {
    if (!isValidIso(t.date)) continue
    const shifted = shift ? addDays(t.date, shift) : t.date
    const date = workday(shifted < from ? from : shifted)
    if (date > to) continue
    const ch = findChannel(t.channel)
    if (!ch || !ch.active) continue
    const cat = ch.category as Category
    const place = (t.place || ch.places?.[0] || ch.name).slice(0, 120)
    const title = fixOwnDomain(t.title.replace(/[–—]/g, '-'), projectSite(proj)).slice(0, 140)
    const brief = t.brief ? fixOwnDomain(t.brief.replace(/[–—]/g, '-'), projectSite(proj)).slice(0, 1000) : null
    if (oldReleaseHit(`${title}\n${brief ?? ''}\n${place}`, releaseFocus(releases, date))) {
      oldRelease++
      continue
    }
    if (isBlindReply({ title, category: cat })) {
      blind++
      continue
    }
    if (rejectedTopicOf(title, rejected)) {
      declined++
      continue
    }
    if ((cat === 'social' && isExcluded(guard, title, place)) || !planAllowsMail({ category: cat, draftKind: CATEGORY_DRAFT[cat] ?? null, title, description: brief }) || duplicateOf({ title, category: cat }, known) || sameTopic(title, cat, known)) {
      skipped++
      continue
    }
    if (cat === 'verzeichnis') {
      const candidate = { title, channel: t.place ?? null, description: brief }
      if (await listingConflict(db, project, candidate, { register, open: openDirs })) {
        listedDup++
        continue
      }
      openDirs.push({ id: `plan-${openDirs.length}`, code: 'neu', title, update: isListingUpdate(title), domains: taskDirectories(candidate, null), dueDate: date, createdAt: now() })
    }
    known.push({ title, category: cat, status: 'geplant' })
    const block = taskBlock(guard, cat, place, ch)
    if (block) {
      blocked++
      await ensureSetupTask(db, proj, block, ch, owner, d)
      continue
    }
    const steps = CATEGORY_STEPS[cat]
    const row = await createTask(db, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      title,
      description: brief,
      category: cat,
      channel: place,
      dueDate: date,
      dueTime: t.time && isValidTime(t.time) ? t.time : ch.time ?? null,
      durationMin: 30,
      estimateMin: steps?.estimate ?? 15,
      prio: 'P2',
      agentStep: steps?.agent ?? 'Entwurf',
      humanStep: steps?.human ?? 'Prüfen',
      assigneeUserId: owner,
      draftKind: CATEGORY_DRAFT[cat] ?? 'text',
      strategyChannel: ch.key,
    })
    taskIds.push(row.id)
  }

  if (blocked) log?.push(`${blocked} Aufgaben ohne Ziel (Blog oder Konto fehlt) nicht geplant, Einrichtungs-Aufgabe angelegt`)
  if (listedDup) log?.push(`${listedDup} Verzeichnis-Aufgaben nicht geplant (dort steht das Projekt schon oder es gibt schon eine Aufgabe dafür)`)
  if (oldRelease) log?.push(`${oldRelease} Aufgaben nicht geplant (nennen ein älteres Release statt des aktuellen)`)
  if (blind) log?.push(`${blind} Community-Antworten nicht geplant (entstehen nur aus echten Threads der Suche oder des Listenings)`)
  if (declined) log?.push(`${declined} Aufgaben nicht geplant (gleiches Thema wie vom Menschen verworfene Aufgaben)`)
  if (skipped) log?.push(`${skipped} Aufgaben nicht geplant (Thema schon vorhanden, laut Fakten ausgeschlossen oder Kaltmail)`)
  const contentKey = channels.find(c => c.active && c.category === 'content')?.key
  if (contentKey) {
    const keep = channels.filter(c => c.active).map(c => c.key)
    const moved = await db.update(schema.tasks).set({ strategyChannel: contentKey, updatedAt: now() }).where(and(
      eq(schema.tasks.projectId, project.id),
      isNull(schema.tasks.recurrenceId),
      inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']),
      sql`(${schema.tasks.category} = 'content' or ${schema.tasks.draftKind} = 'article')`,
      sql`${schema.tasks.strategyChannel} is not null and ${schema.tasks.strategyChannel} not in (${sql.join(keep.map(k => sql`${k}`), sql`, `)})`,
    )).returning({ id: schema.tasks.id })
    if (moved.length) log?.push(`${moved.length} Inhalte in den neuen Content-Kanal übernommen`)
  }
  const materialized = await activateStrategy(db, proj, proposal, d, { userId, agent: !userId, startFrom: addDays(to, 1) })
  return { created: taskIds.length, dropped, materialized }
}

const TOPIC_STOP = new Set(['artikel', 'blog', 'blog-artikel', 'ratgeber', 'guide', 'veröffentlichung', 'beitrag', 'post', 'article', 'vergleich', 'vergleichsseite', 'entwurf', 'der', 'die', 'das', 'und', 'für', 'mit', 'ohne', 'aus', 'the', 'and', 'for', 'with', 'eu', 'de', 'en', 'was', 'ist', 'wie', 'warum', 'neu'])

export function topicWords(title: string): string[] {
  return [...new Set(title.toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-z0-9äöüß-]+/).flatMap(w => [w, ...w.split('-')]).map(w => w.replace(/^-+|-+$/g, '')).filter(w => w.length >= 4 && !TOPIC_STOP.has(w)))]
}

// Gleiches Thema bei Inhalten (Artikel, Ratgeber, Vergleichsseiten): "Bandcamp-Alternative" = "Blog-Artikel: Bandcamp Alternative".
export function sameTopic(title: string, category: string, known: { title: string, category: string, status: string }[]): boolean {
  if (category !== 'content') return false
  const a = topicWords(title)
  if (!a.length) return false
  return known.some((k) => {
    if (k.category !== 'content' || !['geplant', 'entwurf_fertig', 'freigegeben', 'wartet', 'erledigt'].includes(k.status)) return false
    const b = topicWords(k.title)
    if (!b.length) return false
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    return short.every(w => long.includes(w))
  })
}
