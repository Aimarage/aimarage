import type { WorkspaceSettings } from '../../db/schema'
import { config } from '../config'
import { openAppKey } from '../connections'
import type { FetchLike } from '../outlets'
import { errText, jsonOf, PlatformError, timeoutSignal, wait } from './types'

const API = 'https://api.search.brave.com/res/v1/web/search'
const GAP = 1100

type Json = Record<string, unknown>
type Workspace = { id: string, settings: WorkspaceSettings | null }

export interface BraveResult {
  title: string
  url: string
  snippet: string
  age: string | null
  publishedAt: string | null
}

// Eigener Schlüssel des Workspace, gehostet sonst der Betreiber-Schlüssel (BRAVE_API_KEY) mit Grenzen je Tarif.
export function braveKey(ws: Workspace): string | null {
  return openAppKey(ws, 'brave') || hostedBraveKey() || null
}

export function hostedBraveKey(): string {
  return config.braveApiKey
}

export function isHostedBraveKey(key: string): boolean {
  const k = hostedBraveKey()
  return !!k && key === k
}

export function braveSource(ws: Workspace): 'own' | 'hosted' | null {
  if (openAppKey(ws, 'brave')) return 'own'
  return hostedBraveKey() ? 'hosted' : null
}

// Grenze erreicht (Tagesgrenze je Projekt oder Monatsbudget für Dienste): die Suche ruht, kein Fehler im Ablauf.
export class BraveLimitError extends PlatformError {
  constructor(readonly reason: 'day' | 'month') {
    super(reason === 'day' ? 'Websuche ruht: Tagesgrenze für diesen Arbeitsbereich erreicht, geht morgen weiter' : 'Websuche ruht: Budget für Dienste in diesem Monat aufgebraucht', 0)
  }
}

export const BRAVE_PURPOSES = ['listening', 'community', 'reddit', 'forum', 'geo', 'task-check', 'subreddit-rules', 'service', 'other'] as const
export type BravePurpose = typeof BRAVE_PURPOSES[number]
export interface BraveUse { ws: string, project?: string | null, purpose: BravePurpose }

const state = {
  lastAt: 0,
  record: null as ((use: BraveUse, hosted: boolean) => Promise<void>) | null,
  gate: null as ((use: BraveUse) => Promise<'day' | 'month' | null>) | null,
}

export function setBraveRecorder(fn: ((use: BraveUse, hosted: boolean) => Promise<void>) | null): void {
  state.record = fn
}

export function setBraveGate(fn: ((use: BraveUse) => Promise<'day' | 'month' | null>) | null): void {
  state.gate = fn
}

async function count(use: BraveUse | undefined, hosted: boolean): Promise<void> {
  if (!use || !state.record) return
  try {
    await state.record(use, hosted)
  }
  catch (err) {
    console.error('[brave] Zähler fehlgeschlagen:', (err as Error).message)
  }
}

export function resetBraveState(): void {
  state.lastAt = 0
}

export function siteQuery(site: string, words: string[] | string): string {
  const q = (Array.isArray(words) ? words.join(' ') : words).trim()
  return `site:${site}${q ? ` ${q}` : ''}`
}

export function redditQuery(sub: string | null, words: string[] | string): string {
  return siteQuery('reddit.com', [...(sub ? [`r/${sub}`] : []), ...(Array.isArray(words) ? words : [words])])
}

const THREAD = /^https:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]+)(?:\/|$)/i

export function redditThreadOf(url: string): { sub: string, id: string } | null {
  const m = THREAD.exec(url)
  return m ? { sub: m[1]!, id: m[2]!.toLowerCase() } : null
}

function plain(s: unknown): string {
  return typeof s === 'string'
    ? s.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
    : ''
}

export function parseBrave(d: unknown): BraveResult[] {
  const list = ((d as Json | null)?.web as Json | undefined)?.results
  if (!Array.isArray(list)) return []
  return list.map(r => r as Json).filter(r => typeof r.url === 'string' && /^https:\/\//.test(r.url)).map((r) => {
    const at = typeof r.page_age === 'string' && !Number.isNaN(Date.parse(r.page_age)) ? new Date(r.page_age).toISOString() : null
    return { title: plain(r.title), url: String(r.url), snippet: plain(r.description), age: plain(r.age) || null, publishedAt: at }
  })
}

export function redditThreads(list: BraveResult[], sub: string | null = null): BraveResult[] {
  const seen = new Set<string>()
  return list.filter((r) => {
    const t = redditThreadOf(r.url)
    if (!t || (sub && t.sub.toLowerCase() !== sub.toLowerCase()) || seen.has(t.id)) return false
    seen.add(t.id)
    return true
  })
}

export function onSiteResults(list: BraveResult[], host: string): BraveResult[] {
  const h = host.replace(/^www\./, '').toLowerCase()
  return list.filter((r) => {
    const u = new URL(r.url).hostname.replace(/^www\./, '').toLowerCase()
    return u === h || u.endsWith(`.${h}`)
  })
}

export async function braveSearch(key: string, q: string, f: FetchLike, opts: { count?: number, freshness?: string | null, sleep?: (ms: number) => Promise<void>, lang?: string | null, use?: BraveUse } = {}, retry = true): Promise<BraveResult[]> {
  const hosted = isHostedBraveKey(key)
  if (hosted) {
    if (!opts.use) throw new BraveLimitError('day')
    const blocked = state.gate ? await state.gate(opts.use) : null
    if (blocked) throw new BraveLimitError(blocked)
  }
  const gap = state.lastAt + GAP - Date.now()
  if (gap > 0) await wait(opts, gap)
  state.lastAt = Date.now()
  const params: Record<string, string> = { q, count: String(opts.count ?? 10) }
  if (opts.freshness !== null) params.freshness = opts.freshness ?? 'pm'
  if (opts.lang) params.search_lang = opts.lang
  const url = `${API}?${new URLSearchParams(params)}`
  let res: Response
  await count(opts.use, hosted)
  try {
    res = await f(url, { method: 'GET', headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }, signal: timeoutSignal(20_000) })
  }
  catch (err) {
    throw new PlatformError(`Brave: nicht erreichbar (${(err as Error).message.slice(0, 120)})`)
  }
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')?.split(',')[0])
    if (retry && Number.isFinite(reset) && reset <= 2) {
      await wait(opts, Math.max(reset, 1) * 1000)
      return braveSearch(key, q, f, { ...opts }, false)
    }
    throw new PlatformError('Brave: Anfrage-Limit erreicht, später erneut versuchen', 429)
  }
  const data = await jsonOf(res)
  if (res.status === 401 || res.status === 403) throw new PlatformError(`Brave: API-Schlüssel abgelehnt (${res.status})`, res.status)
  if (!res.ok) throw new PlatformError(`Brave: ${errText(data, res.status)}`, res.status)
  return parseBrave(data)
}

export function forumHost(task: { targetUrl?: string | null, channel?: string | null }): string | null {
  try {
    if (task.targetUrl && /^https?:\/\//.test(task.targetUrl)) {
      const u = new URL(task.targetUrl)
      return u.pathname.split('/').filter(Boolean).length <= 1 && !u.search ? u.hostname.replace(/^www\./, '') : null
    }
  }
  catch {
    return null
  }
  const m = task.channel?.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i)
  return m && !/reddit\.com$/i.test(m[1]!) ? m[1]!.toLowerCase().replace(/^www\./, '') : null
}

export async function forumLookup(key: string | null, task: { targetUrl?: string | null, channel?: string | null }, words: string[], f: FetchLike, log: string[], research: boolean, use?: BraveUse): Promise<string | null> {
  const host = forumHost(task)
  if (!key || !host || !words.length) return null
  try {
    const found = onSiteResults(await braveSearch(key, siteQuery(host, words), f, { use }), host).slice(0, 5)
    if (!found.length) return null
    return [
      `Aktuelle Beiträge auf ${host} (letzter Monat, über die Brave-Suche gefunden; nur Titel und Auszug bekannt):`,
      ...found.map((r, i) => `\n${i + 1}. "${r.title}"\nLink: ${r.url}${r.age ? `\n${r.age}` : ''}${r.snippet ? `\nAuszug: ${r.snippet}` : ''}`),
      research
        ? '\nNutze genau diese Beiträge als Fundstellen (mit Link). Keine weiteren erfinden.'
        : '\nWähle den Beitrag, auf den eine hilfreiche Antwort am besten passt, schreibe die Antwort genau darauf (nur Titel und Auszug sind bekannt, nichts dazuerfinden) und setze "targetUrl" exakt auf seinen Link. In "notes" kurz, warum dieser Beitrag.',
    ].join('\n')
  }
  catch (err) {
    log.push(`Brave-Suche fehlgeschlagen: ${(err as Error).message.slice(0, 200)}`)
    return null
  }
}
