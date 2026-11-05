import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { DEFAULT_KPIS, monogram, PROJECT_COLORS, slugify, type ProjectColor } from '../../shared/utils/domain'
import { clampWeight, STRATEGY_CATEGORIES } from '../../shared/utils/plan'
import type { ProjectSetup, StrategyAnalysis, StrategyChannel } from '../db/schema'
import { analysisPrompt, previewPostsPrompt, strategyPrompt, SYSTEM, withRules } from '../prompts/de'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { docsDigest, projectDocs } from './documents'
import { folderDigest, foldersAllowed, readProjectFolder } from './folder'
import { saveGoals, type GoalInput } from './goals'
import { assertProjectLimit } from './limits'
import { chatJson, llmStatus, type ChatResult, type LlmConfig } from './llm'
import { planGuard } from './plan-guard'
import { releaseFocusFor } from './release-focus'
import { releaseRule } from '../../shared/utils/release-focus'
import { minutesPerDay } from '../../shared/utils/strategy-facts'
import { fixOwnDomain } from '../../shared/utils/own-domain'
import { TEASER_POSTS } from './preview'
import { fetchSite, siteDigest } from './site'
import { approveProposal, createStrategyVersion, normalizeChannel, pendingProposal, projectOwner, projectSite, type StrategyRow } from './strategy'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const ANALYSIS_STEPS = ['site', 'folder', 'audiences', 'competitors', 'channels', 'keywords', 'strategy'] as const
export type StepKey = typeof ANALYSIS_STEPS[number]
export type StepState = 'wait' | 'run' | 'ok' | 'skip' | 'error'

export interface Progress {
  steps: { key: StepKey, state: StepState, note?: string | null }[]
  done: boolean
  proposalId?: string | null
}

export interface NewProjectInput {
  name?: string | null
  url?: string | null
  description?: string | null
  color?: ProjectColor | null
  folder?: string | null
  goals?: GoalInput[]
  onboarding?: boolean
  budget?: string | null
}

export function nameFromUrl(url: string | null | undefined): string {
  if (!url) return 'Neues Projekt'
  try {
    const h = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '')
    return h.split('.')[0] || h
  }
  catch {
    return 'Neues Projekt'
  }
}

export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  const u = url.trim()
  try {
    const parsed = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`)
    return /^https?:$/.test(parsed.protocol) ? parsed.href.replace(/\/$/, '') : null
  }
  catch {
    return null
  }
}

export async function createProjectRecord(db: DbOrTx, ws: Workspace, userId: string, input: NewProjectInput, opts: { preview?: boolean } = {}): Promise<Project> {
  await assertProjectLimit(db, ws, opts)
  const name = (input.name?.trim() || nameFromUrl(input.url)).slice(0, 60)
  const base = slugify(name) === 'alle' ? 'alle-projekt' : slugify(name)
  const taken = new Set((await db.select({ slug: schema.projects.slug }).from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), sql`${schema.projects.slug} like ${`${base}%`}`))).map(t => t.slug))
  let slug = base
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
  const all = await db.select({ color: schema.projects.color, code: schema.projects.code }).from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))
  const color = input.color ?? PROJECT_COLORS.find(c => !all.some(p => p.color === c)) ?? 'blue'
  let code = (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'PRJ').padEnd(2, 'X')
  for (let i = 2; all.some(p => p.code === code); i++) code = `${code.slice(0, 3)}${i}`.slice(0, 5)
  const setup: ProjectSetup = { state: input.onboarding === false ? 'ready' : 'onboarding', folder: input.folder ?? null, budget: input.budget ?? null }
  const [p] = await db.insert(schema.projects).values({
    workspaceId: ws.id,
    slug,
    name,
    code,
    color,
    icon: monogram(name).toUpperCase(),
    url: normalizeUrl(input.url),
    description: input.description?.slice(0, 2000) || null,
    kpis: DEFAULT_KPIS,
    setup,
    sortOrder: all.length,
  }).returning()
  await db.insert(schema.projectMembers).values({ projectId: p!.id, userId, role: 'owner' })
  if (input.goals?.length) await saveGoals(db, ws.id, p!.id, input.goals, today(ws.timezone))
  await logActivity(db, { workspaceId: ws.id, projectId: p!.id, actor: 'user', userId, action: 'project_created', detail: { title: name }, at: now() })
  return p!
}

const TEMPLATE: { re: RegExp, channel: Partial<StrategyChannel> & { name: string } }[] = [
  { re: /musik|music|song|künstler|artist|audio|band/i, channel: { name: 'Musiker-Communities (Reddit, Foren)', category: 'community', why: 'Künstler und Hörer sind in Fach-Communities gut erreichbar', weight: 5 } },
  { re: /ki|ai|chatbot|gpt|llm/i, channel: { name: 'KI-Verzeichnisse', category: 'verzeichnis', why: 'Viele Suchende starten in KI-Tool-Verzeichnissen', weight: 3 } },
  { re: /saas|software|app|tool|plattform|platform/i, channel: { name: 'Software-Verzeichnisse (AlternativeTo, SaaSHub)', category: 'verzeichnis', why: 'Dauerhafte Backlinks und Vergleichs-Besucher', weight: 3 } },
]

export function templateChannels(description: string, goalIds: string[]): StrategyChannel[] {
  const out: StrategyChannel[] = []
  for (const t of TEMPLATE) if (t.re.test(description) && !out.some(o => o.category === t.channel.category)) out.push(normalizeChannel({ ...t.channel, goalIds }))
  const base: (Partial<StrategyChannel> & { name: string })[] = [
    { name: 'Communities und Foren', category: 'community', why: 'Hilfreiche Antworten bringen interessierte Besucher', weight: 4 },
    { name: 'Social Media (Instagram, Facebook, LinkedIn)', category: 'social', why: 'Große Reichweite, regelmäßige Sichtbarkeit, wenig Aufwand', weight: 5 },
    { name: 'Blog und Ratgeber', category: 'content', why: 'Wirkt langfristig über Suchmaschinen', weight: 3 },
    { name: 'Verzeichnisse', category: 'verzeichnis', why: 'Schnelle Backlinks und Erstbesucher, 1x pro Woche bis die Liste abgearbeitet ist', weight: 3 },
    { name: 'Presse und Partner', category: 'outreach', why: 'Einzelne Artikel bringen viele Besucher auf einmal', weight: 1 },
  ]
  for (const b of base) if (!out.some(o => o.category === b.category)) out.push(normalizeChannel({ ...b, goalIds }))
  return out
}

const analysisSchema = z.object({
  positioning: z.string().catch(''),
  audiences: z.array(z.string()).catch([]),
  competitors: z.array(z.object({ name: z.string(), url: z.string().nullable().optional(), note: z.string().nullable().optional() })).catch([]),
  communities: z.array(z.string()).catch([]),
  keywords: z.array(z.string()).catch([]),
})

const strategySchema = z.object({
  summary: z.string().catch(''),
  positioning: z.string().catch(''),
  audiences: z.array(z.string()).catch([]),
  budget: z.string().catch(''),
  channels: z.array(z.object({
    name: z.string().min(1),
    category: z.string().catch('social'),
    why: z.string().catch(''),
    goals: z.array(z.string()).catch([]),
    weight: z.number().catch(3),
    days: z.array(z.string()).catch([]),
    places: z.array(z.string()).catch([]),
    topics: z.array(z.string()).catch([]),
  })).min(1),
  tasks: z.array(z.object({
    date: z.string(),
    time: z.string().nullable().optional(),
    channel: z.string().catch(''),
    title: z.string().min(1),
    place: z.string().nullable().optional(),
    brief: z.string().nullable().optional(),
  }).nullable().catch(null)).catch([]),
  drop: z.array(z.string()).catch([]),
})

export type StrategyPlan = z.infer<typeof strategySchema>

async function setProgress(db: DbOrTx, projectId: string, progress: Progress, extra: Partial<ProjectSetup> = {}): Promise<void> {
  const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, projectId))
  await db.update(schema.projects).set({ setup: { ...p?.setup, ...extra, progress } }).where(eq(schema.projects.id, projectId))
}

export function readProgress(setup: ProjectSetup): Progress | null {
  return setup.progress ?? null
}

export interface AnalyzeDeps {
  rethink?: { knowledge?: string | null, reason?: string | null, current?: string | null, planned?: string[], from: string, to: string } | null
  llm: LlmConfig | null
  llmFetch?: FetchLike
  webFetch?: FetchLike
  usage?: ChatResult[]
  log?: string[]
  // Vorschau ohne Tarif: knapper (ohne Reasoning, weniger Tokens), dazu zwei Beispiel-Posts für den Teaser.
  preview?: boolean
}

export async function analyzeProject(db: Db, ws: Workspace, project: Project, deps: AnalyzeDeps): Promise<{ proposal: StrategyRow, analysis: StrategyAnalysis, llmUsed: boolean, plan: StrategyPlan | null }> {
  const steps: Progress['steps'] = ANALYSIS_STEPS.map(key => ({ key, state: 'wait' }))
  const progress: Progress = { steps, done: false }
  const mark = async (key: StepKey, state: StepState, note?: string | null) => {
    const s = steps.find(x => x.key === key)!
    s.state = state
    s.note = note ?? null
    await setProgress(db, project.id, progress)
  }
  const llmOn = !!deps.llm && llmStatus(deps.llm).configured
  const goals = await db.select().from(schema.goals).where(eq(schema.goals.projectId, project.id))

  await mark('site', 'run')
  let siteText = ''
  let siteInfo: ProjectSetup['site'] = null
  if (project.url) {
    const site = await fetchSite(project.url, { fetchImpl: deps.webFetch })
    siteText = siteDigest(site)
    siteInfo = { url: site.url, title: site.pages[0]?.title ?? null, description: site.pages[0]?.description ?? null, pages: site.pages.map(p => ({ url: p.url, title: p.title })), fetchedAt: now().toISOString(), error: site.error }
    await setProgress(db, project.id, progress, { site: siteInfo })
    await mark('site', site.pages.length ? 'ok' : 'error', site.pages.length ? `${site.pages.length} Seiten gelesen` : site.error)
  }
  else {
    await mark('site', 'skip', 'keine Adresse')
  }

  await mark('folder', 'run')
  let folderText = ''
  let folderNote: { ok: boolean, note: string | null } | null = null
  if (project.setup.folder && foldersAllowed()) {
    const f = readProjectFolder(project.setup.folder)
    folderText = folderDigest(f)
    folderNote = { ok: f.files.length > 0, note: f.files.length ? `${f.files.length} Dateien gelesen` : f.error }
  }
  const docs = await projectDocs(db, project.id)
  const docsText = docsDigest(docs, `${project.name} ${project.description ?? ''}`, 4000).join('\n')
  if (docs.length) await mark('folder', 'ok', [folderNote?.note, `${docs.length} Unterlagen gelesen`].filter(Boolean).join(', '))
  else if (folderNote) await mark('folder', folderNote.ok ? 'ok' : 'error', folderNote.note)
  else await mark('folder', 'skip', 'keine Unterlagen')

  const analysis: StrategyAnalysis = {}
  let channels: StrategyChannel[] = []
  let summary = ''
  let plan: StrategyPlan | null = null
  if (llmOn) {
    for (const k of ['audiences', 'competitors', 'channels', 'keywords'] as const) await mark(k, 'run')
    try {
      const { data, usage } = await chatJson(deps.llm!, { reasoning: !deps.rethink && !deps.preview, maxTokens: deps.preview ? 1500 : 2500, messages: [{ role: 'system', content: withRules(SYSTEM, project.rules) }, { role: 'user', content: analysisPrompt({ name: project.name, url: project.url, description: project.description, goals: goals.map(g => `${g.label}${g.targetValue ? `: ${g.targetValue}` : ''}${g.deadline ? ` bis ${g.deadline}` : ''}`), site: siteText, folder: folderText, docs: docsText }) }] }, analysisSchema, deps.llmFetch)
      deps.usage?.push(...usage)
      Object.assign(analysis, { positioning: dash(data.positioning), audiences: data.audiences.slice(0, 4).map(dash), competitors: data.competitors.slice(0, 6).map(c => ({ name: dash(c.name), url: c.url ?? null, note: c.note ? dash(c.note) : null })), communities: data.communities.slice(0, 8).map(dash), keywords: data.keywords.slice(0, 10).map(dash) })
      await mark('audiences', 'ok', `${analysis.audiences!.length}`)
      await mark('competitors', analysis.competitors!.length ? 'ok' : 'skip', `${analysis.competitors!.length}`)
      await mark('channels', 'ok', `${analysis.communities!.length}`)
      await mark('keywords', 'ok', `${analysis.keywords!.length}`)
    }
    catch (err) {
      deps.log?.push(`Analyse: ${(err as Error).message}`)
      const extra = (err as { usage?: ChatResult[] }).usage
      if (extra) deps.usage?.push(...extra)
      for (const k of ['audiences', 'competitors', 'channels', 'keywords'] as const) await mark(k, 'error', 'Antwort unbrauchbar')
    }
    await mark('strategy', 'run')
    try {
      const analysisText = [analysis.positioning, analysis.audiences?.length ? `Zielgruppen: ${analysis.audiences.join('; ')}` : '', analysis.communities?.length ? `Communities: ${analysis.communities.join('; ')}` : '', analysis.keywords?.length ? `Suchbegriffe: ${analysis.keywords.join('; ')}` : '', analysis.competitors?.length ? `Konkurrenz: ${analysis.competitors.map(c => c.name).join('; ')}` : '', project.description ?? ''].filter(Boolean).join('\n')
      const rt = deps.rethink
      const { data, usage } = await chatJson(deps.llm!, { reasoning: !rt && !deps.preview, temperature: 0.4, maxTokens: rt ? 12000 : deps.preview ? 2500 : 4000, messages: [{ role: 'system', content: withRules(SYSTEM, project.rules) }, { role: 'user', content: strategyPrompt({ name: project.name, analysis: analysisText, goals: goals.map(g => ({ id: g.id, label: `${g.label}${g.targetValue ? ` (Ziel ${g.targetValue}${g.deadline ? ` bis ${g.deadline}` : ''})` : ''}` })), budget: project.setup.budget ?? null, minutesPerDay: minutesPerDay(ws.settings, await projectOwner(db, project.id)), url: projectSite(project), knowledge: rt?.knowledge ?? null, reason: rt?.reason ?? null, current: rt?.current ?? null, planned: rt?.planned, tasksFrom: rt?.from ?? null, tasksTo: rt?.to ?? null, targets: planGuard(ws, project), release: releaseRule(await releaseFocusFor(db, project.id, today(ws.timezone))) }) }] }, strategySchema, deps.llmFetch)
      deps.usage?.push(...usage)
      plan = data
      if (data.positioning) analysis.positioning = fixOwnDomain(dash(data.positioning), projectSite(project))
      if (data.audiences.length) analysis.audiences = data.audiences.slice(0, 3).map(dash)
      const goalIds = new Set(goals.map(g => g.id))
      channels = dedupeChannels(data.channels.slice(0, 8).map(c => normalizeChannel({
        name: dash(c.name),
        category: (STRATEGY_CATEGORIES as readonly string[]).includes(c.category) ? c.category : 'social',
        why: dash(c.why),
        goalIds: c.goals.map(g => goals.find(x => x.id === g || x.label.toLowerCase() === g.toLowerCase())?.id ?? '').filter(id => goalIds.has(id)),
        weight: clampWeight(c.weight),
        days: c.days,
        places: c.places,
        topics: c.topics,
      })))
      for (const c of channels) if (!c.goalIds.length) c.goalIds = goals.map(g => g.id)
      summary = [dash(data.summary), data.budget ? dash(data.budget) : ''].filter(Boolean).join(' ')
      await mark('strategy', 'ok', `${channels.length} Kanäle`)
    }
    catch (err) {
      deps.log?.push(`Strategie: ${(err as Error).message}`)
      const extra = (err as { usage?: ChatResult[] }).usage
      if (extra) deps.usage?.push(...extra)
      await mark('strategy', 'error', 'Vorlage verwendet')
    }
  }
  else {
    for (const k of ['audiences', 'competitors', 'channels', 'keywords'] as const) await mark(k, 'skip', 'Agent nicht konfiguriert')
  }
  if (!channels.length) {
    channels = templateChannels(`${project.description ?? ''} ${siteText.slice(0, 1500)}`, goals.map(g => g.id))
    summary ||= 'Startvorlage: wenige Kanäle mit kleinem Takt, nach den ersten Wochen nach Wirkung anpassen.'
    if (!llmOn) await mark('strategy', 'ok', 'Vorlage')
  }
  if (deps.rethink && !plan) throw new Error('Strategie konnte nicht erstellt werden (keine brauchbare Antwort vom Modell)')
  const old = await pendingProposal(db, project.id)
  if (old) await db.update(schema.strategies).set({ status: 'verworfen' }).where(eq(schema.strategies.id, old.id))
  const proposal = await createStrategyVersion(db, project, { channels, summary, status: 'vorschlag', kind: deps.rethink ? 'rethink' : 'initial', byAgent: llmOn })
  const posts = deps.preview && llmOn ? await previewPosts(project, analysis, channels, deps) : null
  progress.done = true
  progress.proposalId = proposal.id
  const [cur] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, project.id))
  await setProgress(db, project.id, progress, { analysis: { ...cur?.setup.analysis, ...analysis }, ...(deps.preview ? { preview: { posts: posts ?? [] } } : {}) })
  if (!deps.rethink) {
    if (analysis.positioning) await db.insert(schema.projectMemory).values({ projectId: project.id, kind: 'fakt', text: `Positionierung: ${analysis.positioning}` })
    if (analysis.audiences?.length) await db.insert(schema.projectMemory).values({ projectId: project.id, kind: 'fakt', text: `Zielgruppen: ${analysis.audiences.join('; ')}` })
    if (analysis.keywords?.length) await db.insert(schema.projectMemory).values({ projectId: project.id, kind: 'fakt', text: `Suchbegriffe: ${analysis.keywords.join('; ')}` })
    if (analysis.communities?.length) await db.insert(schema.projectMemory).values({ projectId: project.id, kind: 'fakt', text: `Communities: ${analysis.communities.join('; ')}` })
  }
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'strategy_proposed', detail: { title: project.name, count: channels.length }, at: now() })
  return { proposal, analysis, llmUsed: llmOn, plan }
}

const postsSchema = z.object({
  posts: z.array(z.object({ channel: z.string().catch(''), text: z.string().min(1) })).catch([]),
})

// Zwei kurze Beispiel-Posts für die Vorschau (ein Aufruf, ohne Reasoning). Fehler oder Deckel: keine Beispiele.
async function previewPosts(project: Project, analysis: StrategyAnalysis, channels: StrategyChannel[], deps: AnalyzeDeps): Promise<{ channel: string, text: string }[]> {
  const top = [...channels].sort((a, b) => b.weight - a.weight).filter(c => c.category === 'social').slice(0, TEASER_POSTS)
  const picks = top.length ? top : [...channels].sort((a, b) => b.weight - a.weight).slice(0, TEASER_POSTS)
  if (!picks.length) return []
  try {
    const { data, usage } = await chatJson(deps.llm!, { reasoning: false, temperature: 0.7, maxTokens: 700, messages: [{ role: 'system', content: withRules(SYSTEM, project.rules) }, { role: 'user', content: previewPostsPrompt({ name: project.name, url: project.url, positioning: analysis.positioning ?? project.description ?? '', audiences: analysis.audiences ?? [], channels: picks.map(c => ({ name: c.name, topics: c.topics ?? [] })) }) }] }, postsSchema, deps.llmFetch)
    deps.usage?.push(...usage)
    return data.posts.slice(0, TEASER_POSTS).map((p, i) => ({ channel: dash(p.channel || picks[i]?.name || ''), text: dash(p.text).slice(0, 1200) }))
  }
  catch (err) {
    deps.log?.push(`Beispiel-Posts: ${(err as Error).message}`)
    const extra = (err as { usage?: ChatResult[] }).usage
    if (extra) deps.usage?.push(...extra)
    return []
  }
}

function dash(s: string): string {
  return s.replace(/[–—]/g, '-').trim()
}

function dedupeChannels(list: StrategyChannel[]): StrategyChannel[] {
  const seen = new Set<string>()
  return list.filter((c) => {
    if (seen.has(c.key)) return false
    seen.add(c.key)
    return true
  })
}

export async function finishOnboarding(db: Db, ws: Workspace, project: Project, userId: string): Promise<{ created: number } | null> {
  const proposal = await pendingProposal(db, project.id)
  if (!proposal) return null
  const created = await approveProposal(db, project, proposal, today(ws.timezone), userId)
  const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, project.id))
  await db.update(schema.projects).set({ setup: { ...p!.setup, state: 'ready' } }).where(eq(schema.projects.id, project.id))
  return { created }
}
