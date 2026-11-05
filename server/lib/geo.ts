import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { diffDays, startOfWeek } from '../../shared/utils/dates'
import type { GeoAnswer, GeoSummary, GeoWeb, ProjectGeo } from '../db/schema'
import { agentReady, projectFacts, withRun, workspaceLlm, type RunOutcome } from './agent'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { chat, chatJson, extractJson, USD_EUR, type ChatResult, type LlmConfig } from './llm'
import { braveKey, braveSearch } from './platforms/brave'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const MAX_CALLS = 20
export const MAX_QUESTIONS = 5
const EXTRA_PREFS = [
  ['openai/gpt-6-sol', 'openai/gpt-5.5', 'openai/gpt-5.4', 'openai/gpt-5.1', 'openai/gpt-5'],
  ['anthropic/claude-sonnet-5-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-5'],
]
const LANG_NAMES: Record<string, string> = { de: 'Deutsch', en: 'Englisch' }

export interface GeoModel {
  id: string
  label: string
  price: { inUsd: number, outUsd: number } | null
}

const modelCache = new Map<string, { at: number, list: { id: string, price: GeoModel['price'] }[] }>()

export function resetGeoCache(): void {
  modelCache.clear()
}

export function modelLabel(id: string): string {
  const name = id.split('/').pop() ?? id
  if (/^claude/i.test(name)) return `Claude ${name.replace(/^claude-/i, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')}`
  if (/^gpt/i.test(name)) return name.replace(/^gpt-/i, 'GPT-')
  return name
}

async function listModels(cfg: LlmConfig, f: FetchLike): Promise<{ id: string, price: GeoModel['price'] }[]> {
  const hit = modelCache.get(cfg.baseUrl)
  if (hit && Date.now() - hit.at < 12 * 3_600_000) return hit.list
  const res = await f(`${cfg.baseUrl}/models`, { method: 'GET', headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {} })
  if (!res.ok) throw new Error(`Modell-Liste HTTP ${res.status}`)
  const data = await res.json() as { data?: { id?: string, pricing?: { prompt?: string | number, completion?: string | number } }[] }
  const list = (data.data ?? []).filter(m => typeof m.id === 'string').map((m) => {
    const pin = Number(m.pricing?.prompt)
    const pout = Number(m.pricing?.completion)
    return { id: m.id!, price: Number.isFinite(pin) && Number.isFinite(pout) ? { inUsd: pin, outUsd: pout } : null }
  })
  modelCache.set(cfg.baseUrl, { at: Date.now(), list })
  return list
}

export async function geoModels(cfg: LlmConfig, f: FetchLike = fetch, log?: string[]): Promise<GeoModel[]> {
  let list: { id: string, price: GeoModel['price'] }[] = []
  if (cfg.provider !== 'anthropic') {
    try {
      list = await listModels(cfg, f)
    }
    catch (err) {
      log?.push(`Modell-Liste nicht lesbar: ${(err as Error).message.slice(0, 160)}`)
    }
  }
  const byId = new Map(list.map(m => [m.id, m]))
  const out: GeoModel[] = [{ id: cfg.model, label: modelLabel(cfg.model), price: byId.get(cfg.model)?.price ?? null }]
  for (const prefs of EXTRA_PREFS) {
    const id = prefs.find(p => byId.has(p) && p !== cfg.model)
    if (id) out.push({ id, label: modelLabel(id), price: byId.get(id)!.price })
  }
  return out
}

export function planCalls(questions: string[], models: GeoModel[], budget: number, week: number): { question: string, model: GeoModel }[] {
  const out: { question: string, model: GeoModel }[] = []
  if (!models.length || !questions.length || budget <= 0) return out
  for (const q of questions) if (out.length < budget) out.push({ question: q, model: models[0]! })
  const extras = models.slice(1)
  const pairs: { question: string, model: GeoModel }[] = []
  for (let i = 0; i < questions.length; i++) {
    for (const m of extras) pairs.push({ question: questions[(i + week) % questions.length]!, model: m })
  }
  for (const p of pairs) if (out.length < budget) out.push(p)
  return out
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '')
  }
  catch {
    return null
  }
}

export function projectAliases(project: Pick<Project, 'name' | 'slug' | 'url'>): string[] {
  const host = hostOf(project.url)
  const label = host?.split('.').slice(0, -1).join('.') ?? null
  return [...new Set([project.name, project.slug, label].filter((x): x is string => !!x).map(norm).filter(x => x.length >= 4))]
}

const recSchema = z.object({ recommendations: z.array(z.object({ name: z.string().catch(''), url: z.string().nullable().optional().catch(null) })).catch([]) })

export function shortName(name: string): string {
  return name.replace(/\s*[([].*$/, '').replace(/\s+[-:|].*$/, '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

export function evaluateAnswer(content: string, project: Pick<Project, 'name' | 'slug' | 'url'>): { mentioned: boolean, position: number | null, competitors: string[] } {
  const aliases = projectAliases(project)
  const host = hostOf(project.url)
  let recs: { name: string, url?: string | null }[] = []
  try {
    const p = recSchema.safeParse(extractJson(content))
    if (p.success) recs = p.data.recommendations.filter(r => r.name.trim())
  }
  catch {}
  const isOwn = (r: { name: string, url?: string | null }) => {
    const n = norm(r.name)
    const h = hostOf(r.url)
    return aliases.some(a => n.includes(a) || (n.length >= 4 && a.includes(n))) || (!!host && !!h && (h === host || h.endsWith(`.${host}`)))
  }
  const idx = recs.findIndex(isOwn)
  const competitors = recs.filter(r => !isOwn(r)).map(r => shortName(r.name)).filter(Boolean).slice(0, 6)
  if (idx >= 0) return { mentioned: true, position: idx + 1, competitors }
  const raw = norm(content)
  return { mentioned: aliases.some(a => raw.includes(a)), position: null, competitors }
}

export function webRank(urls: string[], projectUrl: string | null): number | null {
  const host = hostOf(projectUrl)
  if (!host) return null
  const i = urls.findIndex((u) => {
    const h = hostOf(u)
    return !!h && (h === host || h.endsWith(`.${host}`))
  })
  return i >= 0 ? i + 1 : null
}

function costFor(res: ChatResult, model: GeoModel): ChatResult {
  if (!model.price) return res
  res.costEur = (res.tokensIn * model.price.inUsd + res.tokensOut * model.price.outUsd) * USD_EUR
  return res
}

export async function generateQuestions(cfg: LlmConfig, project: Project, usage: ChatResult[], f?: FetchLike): Promise<string[]> {
  const a = project.setup?.analysis
  const facts = projectFacts(project)
  const lang = project.languages?.[0] ?? 'de'
  const prompt = [
    `Leite 4 typische Fragen ab, die ein potenzieller Kunde einem KI-Assistenten wie ChatGPT oder Claude stellt, wenn er eine Lösung sucht, wie sie dieses Projekt anbietet, ohne das Projekt zu kennen.`,
    `Regeln: Sprache ${LANG_NAMES[lang] ?? lang}. Kurz und natürlich wie echte Nutzerfragen (eine Zeile, höchstens 120 Zeichen). Kein Name des Projekts, seiner Produkte oder seiner Domain. Verschiedene Blickwinkel: Bedarf, Alternative zu einem bekannten Anbieter, ein Kriterium aus den Fakten (z.B. EU, Datenschutz, Preis), Zielgruppe. Nur normale Bindestriche.`,
    '',
    `Projekt: ${project.name}${project.url ? ` (${project.url})` : ''}`,
    project.description ? `Beschreibung: ${project.description}` : '',
    a?.positioning ? `Kernbotschaft: ${a.positioning}` : '',
    a?.audiences?.length ? `Zielgruppen: ${a.audiences.join('; ')}` : '',
    a?.competitors?.length ? `Konkurrenz: ${a.competitors.map(c => c.name).join(', ')}` : '',
    facts.known.length ? `Fakten:\n${facts.known.map(x => `- ${x}`).join('\n')}` : '',
    '',
    'Antworte nur mit JSON: {"questions": ["...", "..."]}',
  ].filter(x => x !== '').join('\n')
  const { data, usage: u } = await chatJson(cfg, { maxTokens: 600, temperature: 0.4, messages: [{ role: 'system', content: 'Du bist Marketing-Analyst für KI-Sichtbarkeit (GEO). Antworte nur mit JSON.' }, { role: 'user', content: prompt }] }, z.object({ questions: z.array(z.string()).catch([]) }), f)
  usage.push(...u)
  return cleanQuestions(data.questions, projectAliases(project))
}

export function cleanQuestions(list: string[], block: string[] = []): string[] {
  const out: string[] = []
  for (const raw of list) {
    const q = raw.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (q.length < 8 || out.some(x => x.toLowerCase() === q.toLowerCase())) continue
    if (block.some(b => norm(q).includes(b))) continue
    out.push(q)
  }
  return out.slice(0, MAX_QUESTIONS)
}

export async function saveGeo(db: DbOrTx, project: Pick<Project, 'id'>, geo: ProjectGeo): Promise<void> {
  await db.update(schema.projects).set({ setup: sql`coalesce(${schema.projects.setup}, '{}'::jsonb) || jsonb_build_object('geo', ${JSON.stringify(geo)}::jsonb)` }).where(eq(schema.projects.id, project.id))
}

const ASK = (lang: string) => lang === 'de'
  ? 'Antworte so, wie du einem Nutzer antworten würdest, aber nur als JSON: {"recommendations": [{"name": "Produkt oder Anbieter", "url": "Website oder null"}], "note": "ein Satz"}. Nenne bis zu 8 konkrete Produkte in der Reihenfolge, in der du sie empfehlen würdest.'
  : 'Answer as you would answer a user, but only as JSON: {"recommendations": [{"name": "product or provider", "url": "website or null"}], "note": "one sentence"}. List up to 8 concrete products in the order you would recommend them.'

export interface ProjectGeoRun {
  answers: GeoAnswer[]
  web: GeoWeb[]
  summary: GeoSummary
  costEur: number
}

export function summarize(answers: GeoAnswer[], web: GeoWeb[]): GeoSummary {
  const counts = new Map<string, number>()
  for (const a of answers) for (const c of a.competitors) counts.set(c, (counts.get(c) ?? 0) + 1)
  const ok = answers.filter(a => !a.error)
  const webOk = web.filter(w => !w.error)
  return {
    asked: ok.length,
    mentioned: ok.filter(a => a.mentioned).length,
    models: [...new Set(ok.map(a => a.label))],
    webAsked: webOk.length,
    webHits: webOk.filter(w => w.rank !== null).length,
    competitors: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n),
  }
}

export async function checkProject(db: Db, ws: Workspace, project: Project, deps: { cfg: LlmConfig, models: GeoModel[], budget: number, usage: ChatResult[], log: string[], llmFetch?: FetchLike, webFetch?: FetchLike, sleep?: (ms: number) => Promise<void> }): Promise<ProjectGeoRun | null> {
  let questions = project.setup?.geo?.questions ?? []
  if (!questions.length) {
    questions = await generateQuestions(deps.cfg, project, deps.usage, deps.llmFetch)
    if (!questions.length) {
      deps.log.push(`${project.name}: keine Fragen erzeugt`)
      return null
    }
    await saveGeo(db, project, { questions, generatedAt: now().toISOString(), editedAt: null })
    deps.log.push(`${project.name}: Fragen erzeugt: ${questions.join(' | ')}`)
  }
  const d = today(ws.timezone)
  const week = Math.floor(diffDays(startOfWeek(d), '2026-01-05') / 7)
  const lang = project.languages?.[0] ?? 'de'
  const before = deps.usage.length
  const answers: GeoAnswer[] = []
  for (const call of planCalls(questions, deps.models, deps.budget, week)) {
    const cfg: LlmConfig = { ...deps.cfg, model: call.model.id, modelFast: call.model.id, fallback: undefined, reasoning: false }
    try {
      const res = costFor(await chat(cfg, { maxTokens: 700, temperature: /^openai\//.test(call.model.id) ? 1 : 0.2, reasoning: false, messages: [{ role: 'user', content: `${call.question}\n\n${ASK(lang)}` }] }, deps.llmFetch, 2, 10), call.model)
      deps.usage.push(res)
      const ev = evaluateAnswer(res.content, project)
      answers.push({ question: call.question, model: call.model.id, label: call.model.label, ...ev })
      deps.log.push(`${project.name} | ${call.model.label} | ${call.question}: ${ev.mentioned ? `genannt${ev.position ? ` (#${ev.position})` : ''}` : 'nicht genannt'}; ${ev.competitors.join(', ')}`)
    }
    catch (err) {
      const extra = (err as { usage?: ChatResult }).usage
      if (extra) deps.usage.push(extra)
      answers.push({ question: call.question, model: call.model.id, label: call.model.label, mentioned: false, position: null, competitors: [], error: (err as Error).message.slice(0, 160) })
      deps.log.push(`${project.name} | ${call.model.label}: Fehler ${(err as Error).message.slice(0, 160)}`)
    }
  }
  const web: GeoWeb[] = []
  const key = braveKey(ws)
  if (key) {
    for (const q of questions) {
      try {
        const res = await braveSearch(key, q, deps.webFetch ?? fetch, { count: 10, freshness: null, lang, sleep: deps.sleep, use: { ws: ws.id, project: project.id, purpose: 'geo' } })
        const top = res.slice(0, 10).map(r => r.url)
        web.push({ question: q, rank: webRank(top, project.url), top: top.map(u => hostOf(u) ?? u).slice(0, 5) })
      }
      catch (err) {
        web.push({ question: q, rank: null, top: [], error: (err as Error).message.slice(0, 160) })
      }
    }
  }
  const costEur = Math.round(deps.usage.slice(before).reduce((s, u) => s + u.costEur, 0) * 1e6) / 1e6
  const summary = summarize(answers, web)
  const row = { workspaceId: ws.id, projectId: project.id, week: startOfWeek(d), checkedAt: now(), answers, web, summary, costEur }
  await db.insert(schema.geoChecks).values(row).onConflictDoUpdate({ target: [schema.geoChecks.projectId, schema.geoChecks.week], set: { checkedAt: row.checkedAt, answers, web, summary, costEur } })
  return { answers, web, summary, costEur }
}

export async function runGeoCheck(db: Db, ws: Workspace, projectId: string | null = null, deps: { llmFetch?: FetchLike, webFetch?: FetchLike, sleep?: (ms: number) => Promise<void> } = {}): Promise<RunOutcome> {
  return withRun(db, ws, 'geo_check', { projectId }, async (ctx) => {
    if (ws.demo) return { status: 'skipped', summary: 'Demo-Arbeitsbereich' }
    if (!agentReady(ws)) return { status: 'skipped', summary: 'Agent nicht konfiguriert' }
    const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt), projectId ? eq(schema.projects.id, projectId) : undefined))
    const list = projects.filter(p => p.url && p.setup?.state !== 'onboarding')
    if (!list.length) return { status: 'skipped', summary: 'Kein Projekt mit Website' }
    const cfg = workspaceLlm(ws)
    const models = await geoModels(cfg, deps.llmFetch ?? fetch, ctx.log)
    ctx.log.push(`Modelle: ${models.map(m => m.id).join(', ')}`)
    const budget = Math.max(1, Math.floor(MAX_CALLS / (projectId ? 1 : list.length)))
    const parts: string[] = []
    let cost = 0
    for (const p of list) {
      const r = await checkProject(db, ws, p, { cfg, models, budget, usage: ctx.usage, log: ctx.log, llmFetch: deps.llmFetch, webFetch: deps.webFetch, sleep: deps.sleep })
      if (!r) continue
      cost += r.costEur
      parts.push(`${p.name} ${r.summary.mentioned}/${r.summary.asked}${r.summary.webAsked ? `, Web ${r.summary.webHits}/${r.summary.webAsked}` : ''}`)
    }
    ctx.log.push(`Kosten KI-Sichtbarkeit: ${cost.toFixed(4)} EUR`)
    if (!parts.length) return { status: 'skipped', summary: 'Keine Fragen' }
    return { status: 'ok', summary: `KI-Sichtbarkeit: ${parts.join('; ')} (${cost.toFixed(3)} EUR)` }
  })
}

export async function latestGeo(db: DbOrTx, projectId: string) {
  const [row] = await db.select().from(schema.geoChecks).where(eq(schema.geoChecks.projectId, projectId)).orderBy(desc(schema.geoChecks.week)).limit(1)
  return row ? { week: row.week, checkedAt: row.checkedAt.toISOString(), answers: row.answers, web: row.web, summary: row.summary, costEur: row.costEur } : null
}

export async function geoDigest(db: DbOrTx, projectId: string): Promise<string | null> {
  const rows = await db.select().from(schema.geoChecks).where(eq(schema.geoChecks.projectId, projectId)).orderBy(desc(schema.geoChecks.week)).limit(2)
  const cur = rows[0]
  if (!cur || !cur.summary.asked) return null
  const s = cur.summary
  const prev = rows[1]?.summary
  const missing = [...new Set(cur.answers.filter(a => !a.error && !a.mentioned).map(a => a.question))].slice(0, 3)
  return [
    `KI-Sichtbarkeit (Woche ab ${cur.week}): in ${s.mentioned} von ${s.asked} KI-Antworten genannt (${s.models.join(', ')})${prev?.asked ? `, Vorwoche ${prev.mentioned} von ${prev.asked}` : ''}.`,
    s.webAsked ? `Web-Suche: Domain bei ${s.webHits} von ${s.webAsked} Käuferfragen in den Top 10.` : '',
    s.competitors.length ? `Von KIs stattdessen empfohlen: ${s.competitors.join(', ')}.` : '',
    missing.length ? `Fragen ohne Nennung: ${missing.join(' | ')}. Inhalte (Ratgeber, Vergleichsseiten, Verzeichnis-Einträge), die genau diese Fragen beantworten, verbessern die Chance, von KIs empfohlen zu werden.` : '',
  ].filter(Boolean).join('\n')
}
