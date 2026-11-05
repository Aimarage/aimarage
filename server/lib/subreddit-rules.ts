import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { addDays } from '../../shared/utils/dates'
import { platformOf, taskType } from '../../shared/utils/drafting'
import { dayList, dayNumber, freshRules, nextPromoDay, promoDayOk, rulesText, subKey, type SubRules } from '../../shared/utils/subreddit'
import type { WorkspaceSettings } from '../db/schema'
import { now } from './clock'
import { updateSettings } from './connections'
import type { Db } from './db'
import { schema } from './db'
import { chatJson, llmStatus, type ChatResult, type LlmConfig } from './llm'
import type { FetchLike } from './outlets'
import { braveKey, braveSearch } from './platforms/brave'
import { timeoutSignal } from './platforms/types'
import { redditApp, RedditClient, subredditsOf, userAgent } from './reddit'
import { updateTask, type TaskRow } from './tasks'

type Workspace = { id: string, settings: WorkspaceSettings | null }
type Json = Record<string, unknown>

export const RULES_NOTE = 'Reddit-Regeln:'

export interface RulesDeps {
  llm: LlmConfig
  fetch: FetchLike
  llmFetch?: typeof fetch
  log: string[]
  usage?: ChatResult[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const line = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

export function rulesDigest(rules: unknown, about: unknown): string {
  const list = Array.isArray((rules as Json | null)?.rules) ? (rules as Json).rules as Json[] : []
  const a = ((about as Json | null)?.data ?? {}) as Json
  return [
    ...list.filter(r => str(r.short_name)).map((r, i) => `${i + 1}. ${str(r.short_name)}${str(r.description) ? `: ${line(str(r.description), 500)}` : ''}`),
    str(a.public_description) ? `Beschreibung: ${line(str(a.public_description), 400)}` : '',
    str(a.submit_text) ? `Hinweis beim Posten: ${line(str(a.submit_text), 1200)}` : '',
  ].filter(Boolean).join('\n')
}

async function publicJson(f: FetchLike, url: string): Promise<unknown> {
  const res = await f(url, { method: 'GET', headers: { 'User-Agent': userAgent(null), 'Accept': 'application/json' }, signal: timeoutSignal(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Regeltext holen: Reddit-App, öffentliches JSON, Brave-Suche; sonst null (dann Allgemeinwissen)
export async function rawRules(ws: Workspace, sub: string, f: FetchLike, log: string[]): Promise<{ text: string, source: SubRules['source'] } | null> {
  const app = redditApp(ws)
  if (app) {
    try {
      const c = new RedditClient(app, f)
      const rules = await c.get(`/r/${sub}/about/rules`)
      const about = await c.get(`/r/${sub}/about`).catch(() => null)
      const text = rulesDigest(rules, about)
      if (text) return { text, source: 'api' }
    }
    catch (err) {
      log.push(`Regeln r/${sub} über die Reddit-App: ${(err as Error).message.slice(0, 160)}`)
    }
  }
  try {
    const rules = await publicJson(f, `https://www.reddit.com/r/${sub}/about/rules.json?raw_json=1`)
    const about = await publicJson(f, `https://www.reddit.com/r/${sub}/about.json?raw_json=1`).catch(() => null)
    const text = rulesDigest(rules, about)
    if (text) return { text, source: 'public' }
  }
  catch (err) {
    log.push(`Regeln r/${sub} öffentlich: ${(err as Error).message.slice(0, 120)}`)
  }
  const key = braveKey(ws)
  if (key) {
    try {
      const hits = await braveSearch(key, `reddit r/${sub} rules self-promotion flair`, f, { freshness: null, count: 8, use: { ws: ws.id, purpose: 'subreddit-rules' } })
      const text = hits.slice(0, 8).map(h => `- ${h.title}: ${line(h.snippet, 300)} (${h.url})`).join('\n')
      if (text) return { text: `Suchtreffer (nur Auszüge):\n${text}`, source: 'search' }
    }
    catch (err) {
      log.push(`Regeln r/${sub} über Brave: ${(err as Error).message.slice(0, 120)}`)
    }
  }
  return null
}

const evalSchema = z.object({
  promo: z.enum(['yes', 'no', 'days', 'unknown']).catch('unknown'),
  days: z.array(z.union([z.string(), z.number()])).catch([]),
  flairRequired: z.boolean().catch(false),
  flair: z.string().nullable().catch(null),
  links: z.enum(['yes', 'no', 'unknown']).catch('unknown'),
  notes: z.array(z.string()).catch([]),
})

export function rulesPrompt(sub: string, raw: string | null): string {
  return [
    `Subreddit-Regeln auswerten: r/${sub}. Es geht um Beiträge eines Entwicklers über sein eigenes Produkt (mit Offenlegung).`,
    raw ? `Regeln und Hinweise:\n${raw}` : 'Die Regeln waren nicht abrufbar. Nutze dein Wissen über dieses Subreddit; was du nicht sicher weißt, ist "unknown" bzw. leer.',
    '',
    'Antworte nur mit JSON:',
    '{"promo": "yes" | "no" | "days" | "unknown", "days": ["Wednesday"], "flairRequired": true, "flair": "exakter Flair-Name für Beiträge über eigene Projekte oder null", "links": "yes" | "no" | "unknown", "notes": ["höchstens 3 kurze, wichtige Auflagen auf Deutsch"]}',
    '"promo": "days", wenn Beiträge über eigene Projekte nur an bestimmten Wochentagen erlaubt sind (dann "days" mit englischen Wochentagen); "no", wenn Eigenwerbung ganz verboten ist; "yes", wenn erlaubt.',
    '"flair" nur, wenn der Name aus den Regeln erkennbar ist. "links": ob Links zum eigenen Produkt erlaubt sind. Nur normale Bindestriche.',
  ].join('\n')
}

export async function evalRules(sub: string, raw: { text: string, source: SubRules['source'] } | null, deps: RulesDeps): Promise<SubRules | null> {
  if (!llmStatus(deps.llm).configured) return null
  try {
    const { data, usage } = await chatJson(deps.llm, { fast: true, maxTokens: 400, messages: [{ role: 'system', content: 'Du wertest Community-Regeln für einen Marketing-Agenten aus. Antworte nur mit JSON.' }, { role: 'user', content: rulesPrompt(sub, raw?.text ?? null) }] }, evalSchema, deps.llmFetch)
    deps.usage?.push(...usage)
    const days = [...new Set(data.days.map(dayNumber).filter((d): d is number => d !== null))].sort()
    const dash = (s: string) => s.replace(/[\u2013\u2014]/g, '-').trim()
    return {
      sub,
      promo: data.promo === 'days' && !days.length ? 'unknown' : data.promo,
      days: data.promo === 'days' ? days : [],
      flairRequired: data.flairRequired,
      flair: data.flair?.trim() ? dash(data.flair).slice(0, 60) : null,
      links: data.links,
      notes: data.notes.map(dash).filter(Boolean).slice(0, 3).map(n => n.slice(0, 160)),
      source: raw?.source ?? 'model',
      at: now().toISOString(),
    }
  }
  catch (err) {
    const extra = (err as { usage?: ChatResult[] }).usage
    if (extra) deps.usage?.push(...extra)
    deps.log.push(`Regeln r/${sub} auswerten fehlgeschlagen: ${(err as Error).message.slice(0, 160)}`)
    return null
  }
}

export function cachedRules(ws: Workspace, sub: string): SubRules | null {
  return ws.settings?.subreddits?.[subKey(sub)] ?? null
}

// Regeln je Subreddit, ein paar Tage im Arbeitsbereich zwischengespeichert
export async function subredditRules(db: Db, ws: Workspace, sub: string, deps: RulesDeps): Promise<SubRules | null> {
  const name = sub.replace(/^\/?r\//i, '')
  const hit = cachedRules(ws, name)
  if (freshRules(hit, now().getTime())) return hit
  const raw = await rawRules(ws, name, deps.fetch, deps.log)
  const r = await evalRules(name, raw, deps)
  if (!r) return hit
  const next = await updateSettings(db, ws.id, s => ({ ...s, subreddits: { ...s.subreddits, [subKey(name)]: r } }))
  ws.settings = { ...ws.settings, subreddits: next.subreddits }
  deps.log.push(`Regeln r/${name} (${r.source}): ${rulesText(r).replace(/\n/g, ' ')}`)
  return r
}

export function isRedditPost(t: Pick<TaskRow, 'title' | 'category' | 'channel' | 'targetUrl' | 'draftKind'>): boolean {
  return platformOf(t) === 'reddit' && taskType(t) === 'post'
}

export function taskSub(t: Pick<TaskRow, 'title' | 'description' | 'channel' | 'targetUrl'>, communities: string[] = []): string | null {
  return subredditsOf(t, communities)[0] ?? null
}

async function noteOnce(db: Db, taskId: string, text: string): Promise<void> {
  const [had] = await db.select({ id: schema.taskNotes.id }).from(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, taskId), eq(schema.taskNotes.text, text))).limit(1)
  if (!had) await db.insert(schema.taskNotes).values({ taskId, byAgent: true, text, createdAt: now() })
}

// Beitrag über das eigene Produkt auf den nächsten erlaubten Tag legen; gibt das neue Datum zurück
export async function fixRedditDay(db: Db, task: TaskRow, r: SubRules, today: string): Promise<string | null> {
  if (!task.projectId || !task.dueDate) return null
  if (r.promo === 'no') {
    await noteOnce(db, task.id, `${RULES_NOTE} r/${r.sub} verbietet Eigenwerbung. Der Beitrag nennt das Produkt nicht; besser als hilfreiche Antwort ohne Produkt planen oder verwerfen.`)
    return null
  }
  const from = task.dueDate < today ? today : task.dueDate
  if (promoDayOk(r, from)) return null
  const to = nextPromoDay(r, from)
  if (to === task.dueDate) return null
  await updateTask(db, task, { dueDate: to }, { type: 'system' })
  await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `${RULES_NOTE} r/${r.sub} erlaubt Beiträge über eigene Projekte nur am ${dayList(r.days)}${r.flair ? ` (Flair "${r.flair}")` : ''}. Termin von ${task.dueDate} auf ${to} verschoben.`, createdAt: now() })
  return to
}

// Offene Reddit-Beiträge der nächsten Wochen auf erlaubte Tage legen; höchstens `fetches` neue Regel-Abrufe je Lauf
export async function fixRedditDays(db: Db, ws: Workspace & { timezone?: string }, today: string, deps: RulesDeps, fetches = 5): Promise<number> {
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']),
    isNotNull(schema.tasks.projectId),
    isNotNull(schema.tasks.dueDate),
    gte(schema.tasks.dueDate, addDays(today, -7)),
    lte(schema.tasks.dueDate, addDays(today, 28)),
    sql`concat_ws(' ', ${schema.tasks.channel}, ${schema.tasks.title}, ${schema.tasks.targetUrl}) ~* '(reddit|(^|[[:space:]/(])r/)'`,
  ))
  let moved = 0
  let left = fetches
  for (const t of rows.filter(isRedditPost)) {
    const sub = taskSub(t)
    if (!sub) continue
    let r = cachedRules(ws, sub)
    if (!freshRules(r, now().getTime()) && left > 0) {
      left--
      r = await subredditRules(db, ws, sub, deps)
    }
    if (r && await fixRedditDay(db, t, r, today)) moved++
  }
  return moved
}

// Zeile für Entwurf und Nachprüfung
export function rulesForDraft(r: SubRules, type: string): string {
  return [
    rulesText(r),
    type === 'post' && r.promo === 'no' ? 'Dieser Beitrag darf das eigene Produkt nicht nennen: reiner Hilfe- oder Diskussionsbeitrag ohne Link.' : '',
    type === 'post' && r.flair ? `Nenne in "notes" den Flair "${r.flair}".` : '',
  ].filter(Boolean).join('\n')
}
