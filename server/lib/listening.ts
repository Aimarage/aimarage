import { isPlatformBlocked } from '../../shared/utils/blocked-platforms'
import { and, desc, eq, gte, inArray, isNull, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import { addDays } from '../../shared/utils/dates'
import { LISTEN_PREFIX, listenModeOf, listenOrigin, parseListenOrigin, SELF_REPLY_PLATFORMS, type ListenKind, type ListenPlatform } from '../../shared/utils/listening'
import { langRule, postLang, toneProblems, toneRules, wrongLang } from '../../shared/utils/convo-tone'
import { OPEN_STATUSES } from '../../shared/utils/domain'
import { internalTextProblems } from '../../shared/utils/outbound-guard'
import { buildUtmUrl } from '../../shared/utils/utm'
import { isNewListenDesc, listenSourceLines, parseListenDesc, type SourceParent } from '../../shared/utils/reply-source'
import type { ProjectListening } from '../db/schema'
import { SYSTEM, withRules } from '../prompts/de'
import { logActivity } from './activity'
import { agentReady, withRun, workspaceLlm, type RunContext, type RunOutcome } from './agent'
import { reviewerFrom, toneReview } from './ai-reviewer'
import { converseProject, CONVO_PER_DAY } from './conversation'
import { strongModelAllowed } from './limits'
import { now, today } from './clock'
import { listConnections, markConnection, openCreds } from './connections'
import type { Db } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'
import { chatJson, llmStatus, writerFrom, type ChatMessage, type LlmConfig } from './llm'
import { bskyRichText, bskySession, rkeyOf } from './platforms/bluesky'
import { braveKey, braveSearch, redditQuery, redditThreads } from './platforms/brave'
import { mastodonBase } from './platforms/mastodon'
import { errText, jsonOf, PlatformError, timeoutSignal, type Creds, type SocialConn } from './platforms/types'
import { zonedToUtc } from './publish'
import { braveThread, parseListing, RedditClient, redditApp, type RedditThread } from './reddit'
import { projectConns } from './listen-account'
import { addTaskLinks } from './task-links'
import { createTask, updateTask } from './tasks'

// Social Listening: sucht je Projekt Posts, in denen jemand genau das sucht, was das Projekt bietet,
// und Reaktionen unter eigenen Posts, bewertet sie mit dem schnellen Modell und legt Antwort-Entwürfe an.
// Bluesky und Mastodon antworten nach der Freigabe selbst, Reddit postet immer der Mensch.

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>
type Json = Record<string, unknown>

export const SEARCH_PER_DAY = 2
export const MENTION_PER_DAY = 5
export const MAX_AGE_H = 48
const REDDIT_AGE_H = 7 * 24
const SEEN_MAX = 600
const TERMS_DAYS = 7
const PAUSE_DAYS = 7
const MAX_CANDIDATES = 25
const PUBLIC_BSKY = 'https://public.api.bsky.app'
const BSKY_PDS = 'https://bsky.social'

// Automatische Antworten brauchen den Sonnet-Prüfer; solange er fehlt, gilt "automatisch" wie "vorschlagen".
export const AUTO_READY = false

export const LABELS: Record<ListenPlatform, string> = { bluesky: 'Bluesky', mastodon: 'Mastodon', reddit: 'Reddit', x: 'X', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube' }

export interface ListenHit {
  platform: ListenPlatform
  kind: ListenKind
  key: string
  url: string
  author: string
  authorId: string
  name: string
  text: string
  at: string
  root: string
  lang: string | null
  bot: boolean
  parent?: string | null
  context?: SourceParent | null
  title?: string
  sub?: string
  stats?: { followers: number | null, likes: number, replies: number, reposts: number, views: number | null } | null
  voice?: 'pin' | 'yes' | null
}

export interface ListenDeps {
  fetch?: FetchLike
  llmFetch?: FetchLike
  llm?: LlmConfig
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

function dash(s: string): string {
  return s.replace(/[\u2013\u2014]/g, '-')
}

export function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'').replace(/&nbsp;/g, ' ')
    .trim()
}

const BOT_NAME = /(^|[\W_])bot([\W_]|$)|bot$|^bot|feed$|news$|rss/i

// Grobe Vorauswahl ohne KI: nur Posts, die nach Frage oder Suche klingen.
const INTENT = /\?|looking for|recommend|suggest|alternative|any good|anyone (know|use|tried|using)|is there (a|an|any)|what('s| is| are) (the|a) (best|good)|which .{0,40}(should|do you|would you)|where (can|do|should) i|who (makes|does|is making|is doing)|tips (for|on)|need (a|an|some) |switch(ing)? (from|away)|replacement for|empfehl|ich suche|wir suchen|suche (ein|eine|nach)|kennt (jemand|ihr)|gibt es (ein|eine|was|da)|alternative zu|wer macht|was nutzt ihr|womit (macht|verwaltet|organisiert)|tipps/i

export function soundsLikeSearch(text: string): boolean {
  return INTENT.test(text)
}

export function bskyHit(p: Json, kind: ListenKind): ListenHit | null {
  const author = obj(p.author)
  const record = obj(p.record)
  const uri = str(p.uri)
  const did = str(author.did)
  const handle = str(author.handle)
  if (!uri || !(did || handle)) return null
  const labels = Array.isArray(author.labels) ? (author.labels as Json[]).map(l => str(l.val)) : []
  const name = str(author.displayName)
  const reply = obj(record.reply)
  return {
    platform: 'bluesky',
    kind,
    key: uri,
    url: `https://bsky.app/profile/${did || handle}/post/${rkeyOf(uri)}`,
    author: handle || did,
    authorId: did || handle,
    name,
    text: str(record.text),
    at: str(record.createdAt) || str(p.indexedAt),
    root: str(obj(reply.root).uri) || uri,
    parent: str(obj(reply.parent).uri) || null,
    lang: Array.isArray(record.langs) ? str(record.langs[0]) || null : null,
    bot: BOT_NAME.test(handle.split('.')[0] ?? '') || /\bbot\b/i.test(name) || labels.some(l => /bot|automated/i.test(l)),
  }
}

export function mastoHit(s: Json, kind: ListenKind, base: string): ListenHit | null {
  const acc = obj(s.account)
  const host = new URL(base).host
  const acct = str(acc.acct)
  const key = str(s.uri) || str(s.url)
  if (!key || !acct) return null
  const full = acct.includes('@') ? acct : `${acct}@${host}`
  const parent = str(s.in_reply_to_id)
  return {
    platform: 'mastodon',
    kind,
    key,
    url: str(s.url) || key,
    author: full,
    authorId: str(acc.url) || full,
    name: str(acc.display_name),
    text: htmlText(str(s.content)),
    at: str(s.created_at),
    root: parent ? `${host}:${parent}` : key,
    parent: parent || null,
    lang: str(s.language) || null,
    bot: acc.bot === true || BOT_NAME.test(acct.split('@')[0] ?? ''),
  }
}

export function redditHit(t: RedditThread): ListenHit {
  return {
    platform: 'reddit',
    kind: 'search',
    key: `reddit:${t.id}`,
    url: t.url,
    author: t.author,
    authorId: t.author,
    name: t.author,
    text: [t.title, t.text].filter(Boolean).join('\n'),
    at: t.createdAt,
    root: `reddit:${t.id}`,
    lang: null,
    bot: /bot$/i.test(t.author) || t.author === 'AutoModerator',
    title: t.title,
    sub: t.sub,
  }
}

export async function getJson(f: FetchLike, label: string, url: string, headers: Record<string, string> = {}): Promise<Json> {
  let res: Response
  try {
    res = await f(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: timeoutSignal(20_000) })
  }
  catch (err) {
    throw new PlatformError(`${label}: nicht erreichbar (${(err as Error).message.slice(0, 120)})`)
  }
  const data = await jsonOf(res)
  if (!res.ok) throw new PlatformError(`${label}: ${errText(data, res.status)}`, res.status)
  return data
}

export async function getList(f: FetchLike, label: string, url: string, headers: Record<string, string> = {}): Promise<Json[]> {
  let res: Response
  try {
    res = await f(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: timeoutSignal(20_000) })
  }
  catch (err) {
    throw new PlatformError(`${label}: nicht erreichbar (${(err as Error).message.slice(0, 120)})`)
  }
  const text = await res.text().catch(() => '')
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  }
  catch {}
  if (!res.ok) throw new PlatformError(`${label}: ${errText(obj(data), res.status)}`, res.status)
  return Array.isArray(data) ? data as Json[] : []
}

interface BskyAuth {
  base: string
  jwt: string
  did: string
  handle: string
}

export async function bskyAuth(conn: SocialConn, creds: Creds, f: FetchLike): Promise<BskyAuth> {
  const base = (conn.url || BSKY_PDS).replace(/\/+$/, '')
  const s = await bskySession(base, creds.identifier!, creds.password!, f)
  return { base, jwt: s.accessJwt, did: s.did, handle: s.handle }
}

export async function bskySearch(q: string, since: string, f: FetchLike, auth: BskyAuth | null): Promise<ListenHit[]> {
  const params = new URLSearchParams({ q, sort: 'latest', since, limit: '25' })
  const host = auth ? auth.base : PUBLIC_BSKY
  const d = await getJson(f, 'Bluesky-Suche', `${host}/xrpc/app.bsky.feed.searchPosts?${params}`, auth ? { Authorization: `Bearer ${auth.jwt}` } : {})
  return (Array.isArray(d.posts) ? d.posts as Json[] : []).map(p => bskyHit(p, 'search')).filter((h): h is ListenHit => !!h)
}

export async function bskyMentions(auth: BskyAuth, f: FetchLike): Promise<ListenHit[]> {
  const d = await getJson(f, 'Bluesky-Mitteilungen', `${auth.base}/xrpc/app.bsky.notification.listNotifications?limit=50`, { Authorization: `Bearer ${auth.jwt}` })
  const list = Array.isArray(d.notifications) ? d.notifications as Json[] : []
  return list.filter(n => ['reply', 'mention', 'quote'].includes(str(n.reason))).map(n => bskyHit(n, 'mention')).filter((h): h is ListenHit => !!h)
}

export async function mastoSearch(base: string, token: string, tags: string[], queries: string[], f: FetchLike): Promise<ListenHit[]> {
  const auth = { Authorization: `Bearer ${token}` }
  const out: ListenHit[] = []
  for (const tag of tags) {
    const list = await getList(f, 'Mastodon-Hashtag', `${base}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`, auth)
    out.push(...list.map(s => mastoHit(s, 'search', base)).filter((h): h is ListenHit => !!h))
  }
  for (const q of queries) {
    const d = await getJson(f, 'Mastodon-Suche', `${base}/api/v2/search?${new URLSearchParams({ q, type: 'statuses', limit: '20' })}`, auth)
    out.push(...(Array.isArray(d.statuses) ? d.statuses as Json[] : []).map(s => mastoHit(s, 'search', base)).filter((h): h is ListenHit => !!h))
  }
  return out
}

export async function mastoMentions(base: string, token: string, f: FetchLike): Promise<ListenHit[]> {
  const list = await getList(f, 'Mastodon-Mitteilungen', `${base}/api/v1/notifications?types[]=mention&limit=40`, { Authorization: `Bearer ${token}` })
  return list.filter(n => str(n.type) === 'mention' && n.status).map(n => mastoHit(obj(n.status), 'mention', base)).filter((h): h is ListenHit => !!h)
}

export async function redditSearch(ws: Workspace, queries: string[], f: FetchLike, project: string | null = null): Promise<ListenHit[]> {
  const key = braveKey(ws)
  const out: RedditThread[] = []
  if (key) {
    for (const q of queries.slice(0, 3)) out.push(...redditThreads(await braveSearch(key, redditQuery(null, q), f, { freshness: 'pw', count: 10, use: { ws: ws.id, project, purpose: 'listening' } })).map(braveThread))
  }
  else {
    const app = redditApp(ws)
    if (!app) return []
    const c = new RedditClient(app, f)
    for (const q of queries.slice(0, 3)) out.push(...parseListing(await c.get('/search', { q, sort: 'new', t: 'week', limit: '25', type: 'link' })))
  }
  return out.filter(t => !t.locked && !t.archived && !t.nsfw).map(redditHit)
}

// Suchbegriffe je Projekt, eine Woche zwischengespeichert.

const termsSchema = z.object({ queries: z.array(z.string()).catch([]), tags: z.array(z.string()).catch([]) })

export function termsPrompt(project: Project, memory: string[]): string {
  const a = project.setup?.analysis
  return [
    'Leite Suchbegriffe für Social Listening ab: Wir suchen auf Bluesky, Mastodon und Reddit Posts, in denen jemand GENAU das sucht, was dieses Projekt bietet, damit wir hilfreich antworten können.',
    '',
    `Projekt: ${project.name}${project.url ? ` (${project.url})` : ''}`,
    project.description ? `Beschreibung: ${project.description}` : '',
    a?.positioning ? `Positionierung: ${a.positioning}` : '',
    a?.audiences?.length ? `Zielgruppen: ${a.audiences.join('; ')}` : '',
    a?.competitors?.length ? `Konkurrenz: ${a.competitors.map(c => c.name).join(', ')}` : '',
    a?.keywords?.length ? `Stichworte: ${a.keywords.join(', ')}` : '',
    memory.length ? `Gedächtnis:\n${memory.map(m => `- ${m}`).join('\n')}` : '',
    `Sprachen: ${project.languages.join(', ')}`,
    '',
    'Regeln:',
    '- "queries": 4 bis 8 kurze Suchanfragen (2 bis 5 Wörter), so wie Leute sie in einen Post schreiben, wenn sie Hilfe oder eine Empfehlung suchen. Beispiele für die Art: "bookmark manager recommendation", "alternative to Pocket", "wer macht KI-Musik", "any good AI bands", "where to sell AI music", "Bandcamp AI alternative". Konkurrenten als "alternative to X" bzw. "X alternative" einbauen.',
    '- Für jede Projektsprache eigene Anfragen (Deutsch und Englisch, wenn beide Sprachen genannt sind).',
    '- Keine Anfragen mit dem eigenen Projektnamen (die finden nur eigene Posts).',
    '- "tags": 3 bis 6 Mastodon-Hashtags ohne #, genau zum Thema des Projekts (z.B. bookmarks, bookmarkmanager, aimusic), in denen solche Fragen auftauchen.',
    '- Keine Sammelbegriffe, unter denen fast alles läuft, was nichts mit dem Projekt zu tun hat (z.B. ai, llm, mcp, selfhosted, opensource, tech, productivity), weder als Hashtag noch als Suchanfrage allein. Eine Technik, die das Projekt nur nutzt oder anbietet (z.B. MCP), ist nicht sein Thema.',
    '',
    'Antworte nur mit JSON: {"queries": ["..."], "tags": ["..."]}',
  ].filter(Boolean).join('\n')
}

// Sammelbegriffe: darunter läuft fast alles (KI-Hardware, Politik, Self-Hosting), selten das Thema eines Projekts.
const BROAD = new Set(['ai', 'ki', 'llm', 'llms', 'mcp', 'genai', 'gpt', 'chatgpt', 'openai', 'claude', 'anthropic', 'gemini', 'localai', 'localllm', 'ml', 'machinelearning', 'deeplearning', 'artificialintelligence', 'agents', 'aiagents', 'tech', 'technology', 'opensource', 'foss', 'selfhosted', 'selfhosting', 'homelab', 'software', 'saas', 'startup', 'startups', 'indiehacker', 'indiehackers', 'buildinpublic', 'programming', 'coding', 'dev', 'developer', 'developers', 'webdev', 'productivity', 'privacy', 'linux', 'internet', 'web', 'apps', 'app', 'tools', 'news', 'business', 'marketing', 'music', 'art'])
const BROAD_WORDS = new Set([...BROAD, 'server', 'servers', 'tool', 'agent', 'model', 'models', 'local', 'open', 'source', 'self', 'hosted', 'new', 'best', 'free', 'the', 'a', 'and', 'for', 'und', 'für'])

export function broadTerm(t: string): boolean {
  const s = t.toLowerCase().replace(/^#/, '').trim()
  if (BROAD.has(s.replace(/[\s_-]+/g, ''))) return true
  const words = s.split(/[\s_-]+/).filter(Boolean)
  return !words.length || words.every(w => BROAD_WORDS.has(w))
}

export function cleanTerms(raw: { queries: string[], tags: string[] }, projectName: string): { queries: string[], tags: string[] } {
  const own = projectName.toLowerCase()
  const queries = [...new Set(raw.queries.map(q => dash(q).replace(/["#]/g, '').replace(/\s+/g, ' ').trim()).filter(q => q.length >= 3 && q.length <= 80 && !q.toLowerCase().includes(own) && !broadTerm(q)))].slice(0, 8)
  const tags = [...new Set(raw.tags.map(t => t.replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase()).filter(t => t.length >= 2 && t.length <= 40 && !broadTerm(t)))].slice(0, 6)
  return { queries, tags }
}

async function listenTerms(db: Db, project: Project, llm: LlmConfig, memory: string[], deps: ListenDeps, ctx: RunContext): Promise<{ queries: string[], tags: string[] }> {
  const cur = project.setup?.listening?.terms
  if (cur?.queries.length && Date.parse(cur.at) > now().getTime() - TERMS_DAYS * 86_400_000) return cleanTerms(cur, project.name)
  const messages: ChatMessage[] = [{ role: 'system', content: withRules(SYSTEM, project.rules) }, { role: 'user', content: termsPrompt(project, memory) }]
  const res = await chatJson(llm, { messages, maxTokens: 600, fast: true }, termsSchema, deps.llmFetch)
  ctx.usage.push(...res.usage)
  const terms = cleanTerms(res.data, project.name)
  if (terms.queries.length) {
    await patchListening(db, project.id, { terms: { ...terms, at: now().toISOString() } })
    ctx.log.push(`${project.name}: Suchbegriffe ${terms.queries.join(' | ')}${terms.tags.length ? `, Hashtags ${terms.tags.map(t => `#${t}`).join(' ')}` : ''}`)
  }
  return terms
}

export async function patchListening(db: Db, projectId: string, patch: Partial<ProjectListening>): Promise<void> {
  await db.execute(sql`update projects set setup = jsonb_set(coalesce(setup, '{}'::jsonb), '{listening}', (case when jsonb_typeof(setup->'listening') = 'object' then setup->'listening' else '{}'::jsonb end) || ${JSON.stringify(patch)}::jsonb) where id = ${projectId}`)
}

// Was schon beantwortet oder vorgeschlagen ist: nie zweimal im selben Thread, an dieselbe Person oder auf denselben Post.

export interface Taken {
  urls: Set<string>
  authors: Set<string>
  roots: Set<string>
}

export function normUrl(u: string): string {
  return u.replace(/^https?:\/\/(www\.|old\.|new\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
}

export async function takenHits(db: Db, workspaceId: string): Promise<Taken> {
  const since = new Date(now().getTime() - 90 * 86_400_000)
  const rows = await db.select({ origin: schema.tasks.origin, url: schema.tasks.targetUrl }).from(schema.tasks)
    .where(and(eq(schema.tasks.workspaceId, workspaceId), gte(schema.tasks.createdAt, since), sql`(${schema.tasks.origin} like 'listening:%' or ${schema.tasks.targetUrl} like '%reddit.com/r/%/comments/%')`))
  const t: Taken = { urls: new Set(), authors: new Set(), roots: new Set() }
  for (const r of rows) {
    if (r.url) t.urls.add(normUrl(r.url))
    const o = parseListenOrigin(r.origin)
    if (o?.kind === 'search') {
      if (o.author) t.authors.add(`${o.platform}:${o.author.toLowerCase()}`)
      if (o.root) t.roots.add(o.root)
    }
    if (o?.kind === 'conversation' && o.root) t.roots.add(o.root)
    const m = r.url ? /reddit\.com\/r\/\w+\/comments\/([a-z0-9]+)/i.exec(r.url) : null
    if (m) t.roots.add(`reddit:${m[1]!.toLowerCase()}`)
  }
  return t
}

export interface OwnIds {
  bluesky: Set<string>
  mastodon: Set<string>
}

export function prefilter(hits: ListenHit[], o: { taken: Taken, seen: Set<string>, own: OwnIds, at: number, competitors: string[], projectName: string }): ListenHit[] {
  const out: ListenHit[] = []
  const keys = new Set<string>()
  const authors = new Set<string>()
  const comp = o.competitors.map(c => c.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(c => c.length >= 4)
  const ownName = o.projectName.toLowerCase()
  for (const h of hits) {
    const author = `${h.platform}:${h.author.toLowerCase()}`
    const maxH = h.platform === 'reddit' ? REDDIT_AGE_H : MAX_AGE_H
    const t = Date.parse(h.at)
    if (keys.has(h.key) || o.seen.has(h.key) || o.taken.urls.has(normUrl(h.url))) continue
    if (h.platform !== 'reddit' && (Number.isNaN(t) || o.at - t > maxH * 3_600_000)) continue
    if (h.platform === 'reddit' && !Number.isNaN(t) && o.at - t > maxH * 3_600_000) continue
    if (h.platform === 'bluesky' && (o.own.bluesky.has(h.authorId) || o.own.bluesky.has(h.author))) continue
    if (h.platform === 'mastodon' && o.own.mastodon.has(h.author.toLowerCase())) continue
    if (h.bot || !h.text.trim()) continue
    if (h.kind === 'search') {
      if (o.taken.authors.has(author) || o.taken.roots.has(h.root) || authors.has(author)) continue
      if (!soundsLikeSearch(h.text)) continue
      if (h.text.toLowerCase().includes(ownName)) continue
      const handle = h.author.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (comp.some(c => handle.includes(c))) continue
    }
    keys.add(h.key)
    authors.add(author)
    out.push(h)
  }
  return out
}

// Bewertung mit dem schnellen Modell.

const verdictSchema = z.object({
  items: z.array(z.object({
    i: z.coerce.number(),
    ok: z.boolean().catch(false),
    negative: z.boolean().catch(false),
    reason: z.string().catch(''),
  })).catch([]),
})

export type Verdict = z.infer<typeof verdictSchema>['items'][number]

function projectLines(project: Project): string {
  const a = project.setup?.analysis
  return [
    `Projekt: ${project.name}${project.url ? ` (${project.url})` : ''}`,
    project.description ? `Beschreibung: ${project.description}` : '',
    a?.positioning ? `Positionierung: ${a.positioning}` : '',
    a?.audiences?.length ? `Zielgruppen: ${a.audiences.join('; ')}` : '',
    a?.competitors?.length ? `Konkurrenz: ${a.competitors.map(c => c.name).join(', ')}` : '',
    `Sprachen des Projekts: ${project.languages.join(', ')}`,
  ].filter(Boolean).join('\n')
}

export function judgePrompt(project: Project, hits: ListenHit[], kind: ListenKind): string {
  const list = hits.map((h, i) => `[${i}] ${LABELS[h.platform]}${h.sub ? ` r/${h.sub}` : ''}, @${h.author}${h.name && h.name !== h.author ? ` (${h.name})` : ''}${h.lang ? `, Sprache ${h.lang}` : ''}:\n${oneLine(h.text, 600)}`).join('\n\n')
  const rules = kind === 'search'
    ? [
        'Prüfe jeden Post streng. "ok" nur, wenn ALLES zutrifft:',
        '1. Echte Suchabsicht: Der Autor sucht selbst gerade eine Empfehlung, ein Werkzeug, einen Anbieter oder eine Alternative (Frage oder Bitte). Keine Ankündigung, kein Werbepost, kein Artikel- oder Newsletter-Teaser, keine Liste, kein Witz, keine rhetorische Frage.',
        '2. Löst sein Problem: Benenne zuerst für dich das konkrete Problem des Autors. "ok" nur, wenn das Projekt oder unser Fachwissen genau dieses Problem löst und die Antwort für ihn wirklich hilfreich und nicht aufdringlich wäre. Nur gleiches Thema, nur Präsenz zeigen oder ein kluger Allgemeinplatz reicht nicht.',
        '3. Nicht von einem Konkurrenten, Anbieter, Händler oder Bot (auch keine automatisierten Feeds, Marketing-Konten oder Gewinnspiele).',
        '4. Sprache des Posts ist eine der Projektsprachen.',
        'Im Zweifel ok=false: lieber gar keine Antwort als eine schlechte. "reason": ein kurzer Satz auf Deutsch, welches Problem der Autor hat und womit wir es lösen (bzw. warum nicht).',
      ]
    : [
        'Das sind Reaktionen auf eigene Posts des Projekts (Antworten, Erwähnungen, Zitate). "ok" = eine Antwort ist sinnvoll: Frage, Kritik, konkretes Feedback, Interesse oder Dank mit Inhalt. Nicht bei reinen Emojis, "nice", Spam, Bots, Beleidigungen oder wenn keine Antwort erwartet wird.',
        '"negative" = ablehnende Reaktion auf uns (Spam- oder Werbe-Vorwurf, Bot-Vorwurf, Ärger, Aufforderung aufzuhören).',
        '"reason": ein kurzer Satz (Deutsch).',
      ]
  return [projectLines(project), '', ...rules, '', 'Posts:', list, '', 'Antworte nur mit JSON: {"items": [{"i": 0, "ok": true, "negative": false, "reason": "..."}]} mit einem Eintrag je Post.'].join('\n')
}

export async function judgeHits(llm: LlmConfig, project: Project, hits: ListenHit[], kind: ListenKind, deps: ListenDeps, ctx: RunContext): Promise<Map<number, Verdict>> {
  if (!hits.length) return new Map()
  const messages: ChatMessage[] = [{ role: 'system', content: 'Du bewertest Social-Media-Posts für ein Marketing-Team. Du antwortest nur mit JSON.' }, { role: 'user', content: judgePrompt(project, hits, kind) }]
  const res = await chatJson(llm, { messages, maxTokens: 300 + hits.length * 60, fast: true }, verdictSchema, deps.llmFetch)
  ctx.usage.push(...res.usage)
  return new Map(res.data.items.filter(x => x.i >= 0 && x.i < hits.length).map(x => [x.i, x]))
}

// Antwort-Entwurf.

const replySchema = z.object({ text: z.string().catch(''), skip: z.boolean().catch(false), why: z.string().catch('') })

export const MAX_CHARS: Record<ListenPlatform, number> = { bluesky: 280, mastodon: 450, reddit: 900, x: 270, threads: 450, tiktok: 150, youtube: 500 }

export function replyPrompt(project: Project, hit: ListenHit, o: { link: string | null, facts: string[], memory: string[] }): string {
  const own = hit.kind === 'mention'
  const lang = postLang(hit.text, hit.lang)
  return [
    projectLines(project),
    project.tonality ? `Tonalität: ${project.tonality}` : '',
    o.facts.length ? `Fakten:\n${o.facts.map(f => `- ${f}`).join('\n')}` : '',
    o.memory.length ? `Gedächtnis:\n${o.memory.map(m => `- ${m}`).join('\n')}` : '',
    '',
    own ? `Jemand hat auf ${LABELS[hit.platform]} auf einen eigenen Post des Projekts reagiert:` : `Gefundener Post auf ${LABELS[hit.platform]}${hit.sub ? ` in r/${hit.sub}` : ''}, in dem jemand etwas sucht:`,
    hit.context?.text ? `Er antwortet auf ${hit.context.ours ? 'diesen Post des Projekts' : `diesen Post${hit.context.author ? ` von @${hit.context.author}` : ''}`}: "${oneLine(hit.context.text, 600)}"` : '',
    `@${hit.author}: "${oneLine(hit.text, 1200)}"`,
    '',
    'Schreibe die Antwort darauf:',
    ...toneRules(own ? 'mention' : 'search'),
    lang ? langRule(lang) : '',
    own ? '- Gehe auf das ein, was die Person geschrieben hat, wie man einem Bekannten antwortet.' : '- Die Person sucht etwas: Sag kurz und locker, was das Projekt ist und warum es zu genau ihrer Frage passt, so wie man es einem Bekannten erzählen würde. Keine Verkaufsrede, kein Ratgeber-Ton.',
    own
      ? '- Es ist der eigene Kanal des Projekts: keine Offenlegung nötig, keinen Link, außer er beantwortet die Frage direkt.'
      : '- Offene Nennung, dass der Antwortende hinter dem Projekt steht (z.B. "I build X" / "ich entwickle X" oder wie es die Projekt-Regeln vorgeben, z.B. "developer behind X"). Die Projekt-Regeln sind verbindlich (Persona, wer spricht, was nie genannt wird).',
    hit.platform === 'reddit'
      ? '- Reddit: kein Link, nur den Namen nennen (der Mensch postet selbst und prüft die Subreddit-Regeln).'
      : o.link ? `- Höchstens ein Link, und dann genau dieser: ${o.link}` : '- Kein Link.',
    `- Höchstens ${MAX_CHARS[hit.platform]} Zeichen${hit.platform === 'bluesky' ? ' inklusive Link' : ''}.`,
    '- Nur Fakten aus den Projektdaten; nichts versprechen, was nicht dasteht (z.B. ist etwas noch nicht offen, dann nur Warteliste bzw. Interesse nennen).',
    '- Nur normale Bindestriche, keine langen Striche.',
    own ? '- Antworte nur, wenn eine Antwort wirklich etwas bringt. Sonst, oder wenn es heikel ist oder Regeln es verbieten: "skip": true und in "why" kurz warum.' : '- Antworte nur, wenn das Projekt wirklich genau das ist, was die Person sucht. Sonst, oder wenn es heikel ist oder Regeln es verbieten: "skip": true und in "why" kurz warum. Keine Antwort nur, um präsent zu sein, keine Allgemeinplätze.',
    '',
    'Antworte nur mit JSON: {"text": "...", "skip": false, "why": ""}',
  ].filter(s => s !== '').join('\n')
}

export function finishReply(text: string, hit: ListenHit, o: { link: string | null, siteHost: string | null, prelim: string | null }): string {
  let t = dash(text).trim().replace(/^["']|["']$/g, '')
  let used = false
  t = t.replace(/https?:\/\/[^\s)>\]]+/g, (m) => {
    const url = m.replace(/[.,;:!?]+$/, '')
    const tail = m.slice(url.length)
    if (hit.platform === 'reddit' || !o.link || used) return tail
    let host = ''
    try {
      host = new URL(url).host.replace(/^www\./, '')
    }
    catch {}
    if (url === o.prelim || url === o.link || (o.siteHost && host === o.siteHost)) {
      used = true
      return `${o.link}${tail}`
    }
    return tail
  }).replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim()
  if (hit.platform === 'mastodon') {
    const at = `@${hit.author}`
    const short = `@${hit.author.split('@')[0]}`
    t = t.replace(new RegExp(`^(${at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b\\s*`, 'i'), '')
    t = `${at} ${t}`
  }
  return t
}

export function replyFits(text: string, platform: ListenPlatform): boolean {
  if (!text.trim()) return false
  if (platform === 'bluesky') return [...new Intl.Segmenter().segment(bskyRichText(text).text)].length <= 300
  if (platform === 'mastodon') return text.length <= 500
  return text.length <= 2000
}

function siteHostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).host.replace(/^www\./, '') : null
  }
  catch {
    return null
  }
}

function listenLink(project: Project, platform: ListenPlatform, code: string): string | null {
  const u = buildUtmUrl(project.url, { channel: LABELS[platform], category: 'community', code })
  if (!u) return null
  const x = new URL(u)
  x.searchParams.set('utm_content', 'listening')
  return x.toString()
}

// Worauf der Treffer antwortet (Elternbeitrag), damit der Mensch den Zusammenhang ohne Klick sieht.

export interface ParentLookup {
  bsky: BskyAuth | null
  masto: { base: string, token: string } | null
  own: OwnIds
  f: FetchLike
}

function asParent(h: ListenHit, own: Set<string>): SourceParent {
  const a = h.author.toLowerCase()
  const ours = own.has(h.authorId) || own.has(h.author) || own.has(a) || own.has(a.split('@')[0] ?? a)
  return { author: h.author, ours, at: h.at || null, text: h.text, url: h.url }
}

async function bskyPost(auth: BskyAuth, uri: string, f: FetchLike): Promise<Json | null> {
  const d = await getJson(f, 'Bluesky', `${auth.base}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`, { Authorization: `Bearer ${auth.jwt}` })
  const p = Array.isArray(d.posts) ? obj(d.posts[0]) : {}
  return str(p.uri) ? p : null
}

export async function parentOf(h: ListenHit, l: ParentLookup): Promise<SourceParent | null> {
  if (!h.parent) return null
  try {
    if (h.platform === 'bluesky' && l.bsky) {
      const p = await bskyPost(l.bsky, h.parent, l.f)
      const ph = p ? bskyHit(p, 'search') : null
      return ph ? asParent(ph, l.own.bluesky) : null
    }
    if (h.platform === 'mastodon' && l.masto) {
      const d = await getJson(l.f, 'Mastodon', `${l.masto.base}/api/v1/statuses/${encodeURIComponent(h.parent)}`, { Authorization: `Bearer ${l.masto.token}` })
      const ph = mastoHit(d, 'search', l.masto.base)
      return ph ? asParent(ph, l.own.mastodon) : null
    }
  }
  catch {}
  return null
}

async function hitAt(url: string, platform: ListenPlatform, kind: ListenKind, l: ParentLookup): Promise<ListenHit | null> {
  try {
    if (platform === 'bluesky' && l.bsky) {
      const m = /bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/.exec(url)
      const p = m ? await bskyPost(l.bsky, `at://${m[1]}/app.bsky.feed.post/${m[2]}`, l.f) : null
      return p ? bskyHit(p, kind) : null
    }
    if (platform === 'mastodon' && l.masto) {
      const d = await getJson(l.f, 'Mastodon', `${l.masto.base}/api/v2/search?${new URLSearchParams({ q: url, type: 'statuses', resolve: 'true', limit: '1' })}`, { Authorization: `Bearer ${l.masto.token}` })
      return Array.isArray(d.statuses) && d.statuses[0] ? mastoHit(obj(d.statuses[0]), kind, l.masto.base) : null
    }
  }
  catch {}
  return null
}

// Offene Antwort-Aufgaben mit alter Beschreibung ("Reaktion auf einen eigenen Beitrag ...") bekommen
// einmalig die neue Form mit Elternbeitrag.
export async function refreshOldSources(db: Db, projectId: string, l: ParentLookup, max = 5): Promise<number> {
  const rows = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), like(schema.tasks.origin, `${LISTEN_PREFIX}%`), inArray(schema.tasks.status, OPEN_STATUSES)))
  let n = 0
  for (const t of rows) {
    if (n >= max || !t.description || isNewListenDesc(t.description)) continue
    const src = parseListenDesc(t.description, t.createdAt.toISOString())
    const o = parseListenOrigin(t.origin)
    if (!src || !o) continue
    const url = src.url ?? t.targetUrl ?? ''
    const fresh = url ? await hitAt(url, o.platform, o.kind, l) : null
    const parent = fresh ? await parentOf(fresh, l) : null
    const lines = listenSourceLines({ kind: o.kind, author: fresh?.author ?? src.author ?? o.author, text: fresh?.text || src.text, url: fresh?.url ?? url, at: fresh?.at || src.at || '', sub: src.sub, parent })
    const rest = t.description.split('\n').slice(src.url ? 3 : 2)
    await db.update(schema.tasks).set({ description: [...lines, ...rest].join('\n') }).where(eq(schema.tasks.id, t.id))
    n++
  }
  return n
}

async function dayStart(ws: Workspace): Promise<Date> {
  return zonedToUtc(today(ws.timezone), '00:00', ws.timezone)
}

export async function createdSince(db: Db, projectId: string, platform: ListenPlatform, kind: ListenKind, since: Date): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), like(schema.tasks.origin, `listening:${platform}|${kind}|%`), gte(schema.tasks.createdAt, since)))
  return r?.n ?? 0
}

export async function repliedSince(db: Db, projectId: string, platform: ListenPlatform, kind: ListenKind, since: Date): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), like(schema.tasks.origin, `listening:${platform}|${kind}|%`), eq(schema.tasks.status, 'erledigt'), gte(schema.tasks.doneAt, since)))
  return r?.n ?? 0
}

export function listeningSources(ws: Workspace): boolean {
  return listConnections(ws).some(c => c.platform === 'bluesky' || c.platform === 'mastodon') || !!braveKey(ws) || !!redditApp(ws)
}

interface ProjectResult {
  found: number
  drafted: number
  errors: string[]
}

async function draftReply(db: Db, ws: Workspace, project: Project, hit: ListenHit, verdict: Verdict, o: { llm: LlmConfig, deps: ListenDeps, ctx: RunContext, facts: string[], memory: string[], handle: string | null }): Promise<boolean> {
  const prelim = listenLink(project, hit.platform, 'listening')
  const messages: ChatMessage[] = [{ role: 'system', content: withRules(SYSTEM, project.rules) }, { role: 'user', content: replyPrompt(project, hit, { link: prelim, facts: o.facts, memory: o.memory }) }]
  const writer = o.deps.llm ? o.llm : writerFrom(workspaceLlm(ws, 'draft_social'), strongModelAllowed(ws))
  let res = await chatJson(writer, { messages, maxTokens: 700 }, replySchema, o.deps.llmFetch)
  o.ctx.usage.push(...res.usage)
  if (res.data.skip || !res.data.text.trim()) {
    o.ctx.log.push(`${project.name}: ${LABELS[hit.platform]} ${hit.url} ausgelassen: ${res.data.why || 'kein Text'}`)
    return false
  }
  const kind = hit.kind === 'mention' ? 'mention' : 'search'
  const postLanguage = postLang(hit.text, hit.lang)
  const problemsOf = (t: string) => {
    const body = dash(t).replace(/https?:\/\/\S+/g, '')
    const wrong = wrongLang(body, postLanguage)
    return [...toneProblems(body, { kind }), ...(wrong ? [wrong] : [])]
  }
  let problems = problemsOf(res.data.text)
  if (problems.length) {
    const again = await chatJson(writer, { messages: [...messages, { role: 'assistant', content: JSON.stringify(res.data) }, { role: 'user', content: `So geht es nicht: ${problems.join(', ')}. Schreibe die Antwort kürzer und natürlicher neu, nach denselben Regeln. Antworte nur mit JSON wie oben.` }], maxTokens: 700 }, replySchema, o.deps.llmFetch)
    o.ctx.usage.push(...again.usage)
    problems = again.data.skip || !again.data.text.trim() ? ['übersprungen'] : problemsOf(again.data.text)
    res = again
  }
  if (problems.length) {
    o.ctx.log.push(`${project.name}: ${LABELS[hit.platform]} ${hit.url} ausgelassen: Bannliste (${problems.slice(0, 4).join(', ')})`)
    return false
  }
  const checker = o.deps.llm ? o.llm : reviewerFrom(workspaceLlm(ws, 'draft_check'), strongModelAllowed(ws))?.cfg ?? o.llm
  const tone = await toneReview(checker, { platform: LABELS[hit.platform], kind, author: hit.author, post: hit.text, examples: [], variants: [dash(res.data.text).trim()], rules: project.rules, lang: postLanguage }, o.ctx.usage, o.ctx.log, o.deps.llmFetch)
  if (!tone.ok.length) {
    o.ctx.log.push(`${project.name}: ${LABELS[hit.platform]} ${hit.url} ausgelassen: Ton-Prüfung (${tone.reason || 'klingt nicht echt'})`)
    return false
  }
  const at = now()
  const label = LABELS[hit.platform]
  const origin = listenOrigin({ platform: hit.platform, kind: hit.kind, author: hit.author, root: hit.root })
  const self = hit.platform === 'reddit'
  const title = hit.kind === 'mention' ? `${label}: Antwort an @${oneLine(hit.author, 40)}` : `${label}: Antwort auf "${oneLine(hit.title || hit.text, 60)}"`
  const description = [
    ...listenSourceLines({ kind: hit.kind, author: hit.author, text: hit.text, url: hit.url, at: hit.at, sub: hit.sub, parent: hit.context ?? null }),
    verdict.reason ? `Warum: ${dash(verdict.reason)}` : '',
    self ? 'Reddit erlaubt keine Bots: bitte selbst im Thread posten und danach "Gepostet" drücken.' : `Nach dem Freigeben antwortet Aimarage selbst${o.handle ? ` über ${o.handle}` : ''}.`,
  ].filter(Boolean).join('\n')
  const lang = postLanguage ?? project.languages[0] ?? null
  return db.transaction(async (tx) => {
    const task = await createTask(tx, {
      workspaceId: ws.id,
      projectId: project.id,
      title,
      description,
      category: 'community',
      channel: self ? `Reddit r/${hit.sub ?? ''}`.trim() : label,
      language: lang,
      dueDate: today(ws.timezone),
      durationMin: self ? 10 : 5,
      status: 'entwurf_fertig',
      draftKind: 'text',
      targetUrl: hit.url,
      origin,
      humanStep: self ? 'Selbst im Thread posten' : null,
    })
    const link = listenLink(project, hit.platform, task.code)
    const body = finishReply(res.data.text, hit, { link, siteHost: siteHostOf(project.url), prelim })
    if (!replyFits(body, hit.platform)) {
      await tx.delete(schema.tasks).where(eq(schema.tasks.id, task.id))
      o.ctx.log.push(`${project.name}: Antwort zu lang für ${label}, ausgelassen (${hit.url})`)
      return false
    }
    await tx.insert(schema.drafts).values({ taskId: task.id, version: 1, kind: 'text', body, targetUrl: hit.url, byAgent: true, aiGenerated: true, runId: o.ctx.runId, createdAt: at })
    await logActivity(tx, { workspaceId: ws.id, projectId: project.id, taskId: task.id, actor: 'agent', action: 'draft_created', detail: { title: task.title, listening: hit.platform }, at })
    return true
  })
}

export async function listenProject(db: Db, ws: Workspace, project: Project, o: { llm: LlmConfig, deps: ListenDeps, ctx: RunContext }): Promise<ProjectResult> {
  const f = o.deps.fetch ?? fetch
  const at = now().getTime()
  const result: ProjectResult = { found: 0, drafted: 0, errors: [] }
  const st = project.setup?.listening ?? {}
  const paused = !!st.pausedUntil && Date.parse(st.pausedUntil) > at
  const memory = (await db.select({ text: schema.projectMemory.text }).from(schema.projectMemory).where(eq(schema.projectMemory.projectId, project.id)).orderBy(desc(schema.projectMemory.createdAt)).limit(15)).map(m => m.text)
  const facts = [...(project.setup?.facts?.known ?? []), ...(project.setup?.facts?.avoid ?? []).map(a => `Nie behaupten: ${a}`)]
  const terms = paused ? { queries: [], tags: [] } : await listenTerms(db, project, o.llm, memory, o.deps, o.ctx)
  const since = new Date(at - MAX_AGE_H * 3_600_000).toISOString()
  const hits: ListenHit[] = []
  const own: OwnIds = { bluesky: new Set(), mastodon: new Set() }
  const handles: Partial<Record<ListenPlatform, string>> = {}
  const look: ParentLookup = { bsky: null, masto: null, own, f }
  const notif: Record<string, string> = { ...st.notif }
  const fresh = (connId: string, h: ListenHit) => !notif[connId] || Date.parse(h.at) > Date.parse(notif[connId]!)
  const mark = (connId: string, list: ListenHit[]) => {
    const last = list.map(h => h.at).filter(x => !Number.isNaN(Date.parse(x))).sort().pop()
    if (last && (!notif[connId] || last > notif[connId]!)) notif[connId] = last
  }
  const fail = async (conn: SocialConn | null, err: unknown) => {
    const msg = (err as Error).message.slice(0, 300)
    result.errors.push(`${project.name}: ${msg}`)
    if (conn && err instanceof PlatformError && (err.status === 401 || err.status === 403)) await markConnection(db, ws.id, conn.id, { error: msg, checkedAt: new Date().toISOString() })
  }
  for (const conn of projectConns(ws, project, 'bluesky')) {
    const creds = openCreds(ws.id, conn)
    if (!creds) continue
    try {
      const auth = await bskyAuth(conn, creds, f)
      own.bluesky.add(auth.did).add(auth.handle)
      look.bsky ??= auth
      handles.bluesky = `@${auth.handle}`
      const mentions = await bskyMentions(auth, f)
      hits.push(...mentions.filter(h => fresh(conn.id, h)))
      mark(conn.id, mentions)
      for (const q of terms.queries.slice(0, 6)) hits.push(...await bskySearch(q, since, f, auth))
    }
    catch (err) {
      await fail(conn, err)
    }
  }
  for (const conn of projectConns(ws, project, 'mastodon')) {
    const creds = openCreds(ws.id, conn)
    if (!creds?.token) continue
    try {
      const base = mastodonBase(conn.url)
      if (conn.handle) own.mastodon.add(conn.handle.toLowerCase())
      look.masto ??= { base, token: creds.token }
      handles.mastodon = conn.handle ? `@${conn.handle}` : conn.name
      const mentions = await mastoMentions(base, creds.token, f)
      hits.push(...mentions.filter(h => fresh(conn.id, h)))
      mark(conn.id, mentions)
      if (terms.queries.length || terms.tags.length) hits.push(...await mastoSearch(base, creds.token, terms.tags.slice(0, 5), terms.queries.slice(0, 2), f))
    }
    catch (err) {
      await fail(conn, err)
    }
  }
  if (terms.queries.length && (braveKey(ws) || redditApp(ws)) && !isPlatformBlocked(project, 'reddit')) {
    try {
      hits.push(...await redditSearch(ws, terms.queries, f, project.id))
    }
    catch (err) {
      await fail(null, err)
    }
  }
  const taken = await takenHits(db, ws.id)
  const seen = new Set(st.seen ?? [])
  const cand = prefilter(hits, { taken, seen, own, at, competitors: (project.setup?.analysis?.competitors ?? []).map(c => c.name), projectName: project.name })
  const start = await dayStart(ws)
  const judged: string[] = []
  for (const kind of ['mention', 'search'] as const) {
    if (kind === 'search' && paused) continue
    const list = cand.filter(h => h.kind === kind).slice(0, MAX_CANDIDATES)
    if (!list.length) continue
    const verdicts = await judgeHits(o.llm, project, list, kind, o.deps, o.ctx)
    judged.push(...list.map(h => h.key))
    if (kind === 'mention') {
      const ours = await ourReplies(db, project.id)
      const neg = list.find((h, i) => verdicts.get(i)?.negative && h.parent && ours.has(replyKey(h.platform, h.parent)))
      if (neg) {
        const until = new Date(at + PAUSE_DAYS * 86_400_000).toISOString()
        const reason = `Negative Reaktion von @${neg.author} auf eine Listening-Antwort: ${oneLine(neg.text, 160)}`
        await patchListening(db, project.id, { pausedUntil: until, pauseReason: reason })
        await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'listening_paused', detail: { title: project.name, until, reason }, at: now() })
        o.ctx.log.push(`${project.name}: Social Listening pausiert bis ${until.slice(0, 10)} (${reason})`)
      }
    }
    for (const platform of ['bluesky', 'mastodon', 'reddit'] as const) {
      const cap = kind === 'search' ? SEARCH_PER_DAY : MENTION_PER_DAY
      let left = cap - await createdSince(db, project.id, platform, kind, start)
      for (const [i, h] of list.entries()) {
        if (h.platform !== platform || left <= 0) continue
        const v = verdicts.get(i)
        if (!v?.ok) continue
        result.found++
        if (h.parent && h.context === undefined) h.context = await parentOf(h, look)
        if (await draftReply(db, ws, project, h, v, { ...o, facts, memory, handle: handles[platform] ?? null })) {
          result.drafted++
          left--
        }
      }
    }
  }
  if (!paused) {
    const cv = await converseProject(db, ws, project, { llm: o.llm, deps: o.deps, ctx: o.ctx, own, taken: await takenHits(db, ws.id), seen, facts, handles, bskyAuth: look.bsky, mastoBase: look.masto?.base ?? null, tags: terms.tags, queries: terms.queries })
      .catch((err) => {
        result.errors.push(`${project.name}: Mitreden: ${(err as Error).message.slice(0, 300)}`)
        return null
      })
    if (cv) {
      result.found += cv.found
      result.drafted += cv.drafted
      result.errors.push(...cv.errors)
      judged.push(...cv.judged)
    }
  }
  await refreshOldSources(db, project.id, look).catch(err => o.ctx.log.push(`${project.name}: alte Antwort-Aufgaben nicht aufgefrischt: ${(err as Error).message.slice(0, 200)}`))
  await patchListening(db, project.id, { seen: [...judged, ...(st.seen ?? [])].slice(0, SEEN_MAX), notif, lastRun: now().toISOString() })
  return result
}

export function replyKey(platform: ListenPlatform, ref: string): string {
  if (platform === 'bluesky') return `bluesky:${rkeyOf(ref)}`
  return `${platform}:${ref.split('/').pop() ?? ref}`
}

async function ourReplies(db: Db, projectId: string): Promise<Set<string>> {
  const rows = await db.select({ url: schema.tasks.postedUrl, origin: schema.tasks.origin }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), like(schema.tasks.origin, 'listening:%'), sql`${schema.tasks.origin} not like '%|mention|%'`, eq(schema.tasks.status, 'erledigt')))
  const out = new Set<string>()
  for (const r of rows) {
    const o = parseListenOrigin(r.origin)
    if (o && r.url) out.add(replyKey(o.platform, r.url.replace(/\/+$/, '')))
  }
  return out
}

export async function runListening(db: Db, ws: Workspace, deps: ListenDeps = {}): Promise<RunOutcome> {
  return withRun(db, ws, 'social_listening', {}, async (ctx) => {
    if (!deps.llm && !agentReady(ws)) return { status: 'skipped', summary: 'Agent aus oder nicht konfiguriert' }
    const llm = deps.llm ?? workspaceLlm(ws, 'thread_query')
    if (!llmStatus(llm).configured) return { status: 'skipped', summary: 'Agent nicht konfiguriert' }
    const projects = (await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))).filter(p => listenModeOf(p.setup) !== 'off')
    let found = 0
    let drafted = 0
    const errors: string[] = []
    for (const p of projects) {
      const r = await listenProject(db, ws, p, { llm, deps, ctx })
      found += r.found
      drafted += r.drafted
      errors.push(...r.errors)
    }
    ctx.log.push(...errors)
    if (!projects.length) return { status: 'skipped', summary: 'Social Listening ist in keinem Projekt an' }
    return { status: 'ok', summary: `Social Listening und Mitreden: ${found} passende Posts, ${drafted} Entwürfe${errors.length ? `, ${errors.length} Fehler: ${errors[0]}` : ''}` }
  })
}

// Antworten nach der Freigabe (nur Bluesky und Mastodon).

async function bskyResolve(auth: BskyAuth, url: string, f: FetchLike): Promise<{ uri: string, cid: string, root: { uri: string, cid: string } }> {
  const m = /bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/.exec(url)
  if (!m) throw new PlatformError('Bluesky: Link des Posts nicht lesbar')
  const uri = `at://${m[1]}/app.bsky.feed.post/${m[2]}`
  const d = await getJson(f, 'Bluesky', `${auth.base}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`, { Authorization: `Bearer ${auth.jwt}` })
  const p = Array.isArray(d.posts) ? obj(d.posts[0]) : {}
  if (!str(p.uri) || !str(p.cid)) throw new PlatformError('Bluesky: Post nicht mehr vorhanden')
  const root = obj(obj(obj(p.record).reply).root)
  return { uri: str(p.uri), cid: str(p.cid), root: str(root.uri) && str(root.cid) ? { uri: str(root.uri), cid: str(root.cid) } : { uri: str(p.uri), cid: str(p.cid) } }
}

export async function bskyReply(conn: SocialConn, creds: Creds, targetUrl: string, text: string, f: FetchLike): Promise<string> {
  const auth = await bskyAuth(conn, creds, f)
  const parent = await bskyResolve(auth, targetUrl, f)
  const rich = bskyRichText(text)
  const record: Json = { $type: 'app.bsky.feed.post', text: rich.text, createdAt: now().toISOString(), reply: { root: parent.root, parent: { uri: parent.uri, cid: parent.cid } } }
  if (rich.facets.length) record.facets = rich.facets
  const res = await f(`${auth.base}/xrpc/com.atproto.repo.createRecord`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${auth.jwt}` }, body: JSON.stringify({ repo: auth.did, collection: 'app.bsky.feed.post', record }), signal: timeoutSignal(30_000) })
  const data = await jsonOf(res)
  if (!res.ok) throw new PlatformError(`Bluesky: ${errText(data, res.status)}`, res.status)
  return `https://bsky.app/profile/${auth.handle}/post/${rkeyOf(String(data.uri))}`
}

export async function mastoReply(conn: SocialConn, creds: Creds, targetUrl: string, text: string, f: FetchLike, key: string): Promise<string> {
  const base = mastodonBase(conn.url)
  const auth = { Authorization: `Bearer ${creds.token}` }
  const d = await getJson(f, 'Mastodon', `${base}/api/v2/search?${new URLSearchParams({ q: targetUrl, type: 'statuses', resolve: 'true', limit: '1' })}`, auth)
  const target = Array.isArray(d.statuses) ? obj(d.statuses[0]) : {}
  if (!str(target.id)) throw new PlatformError('Mastodon: Post nicht gefunden oder nicht mehr vorhanden')
  const res = await f(`${base}/api/v1/statuses`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': `ml-${key}`.slice(0, 64) }, body: JSON.stringify({ status: text, in_reply_to_id: str(target.id), visibility: 'public' }), signal: timeoutSignal(30_000) })
  const data = await jsonOf(res)
  if (!res.ok) throw new PlatformError(res.status === 401 ? 'Mastodon: Zugangstoken abgelehnt' : `Mastodon: ${errText(data, res.status)}`, res.status)
  return str(data.url) || `${base}/web/statuses/${str(data.id)}`
}

async function backToHuman(db: Db, ws: Workspace, task: Task, draftId: string, message: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(schema.drafts).set({ status: 'offen', approvedAt: null, approvedByUserId: null }).where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.status, 'freigegeben')))
    const [cur] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    if (cur && cur.status === 'freigegeben') await updateTask(tx, cur, { status: 'entwurf_fertig' }, { type: 'agent' })
    await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Antworten fehlgeschlagen: ${message}. Bitte prüfen und erneut freigeben oder selbst antworten.`, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'social_failed', detail: { title: task.title, error: message.slice(0, 300) }, at: now() })
  })
}

export async function sendListeningReply(db: Db, ws: Workspace, payload: { taskId: string, draftId: string }, f: FetchLike = fetch): Promise<RunOutcome> {
  const [task] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.id, payload.taskId), eq(schema.tasks.workspaceId, ws.id)))
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, payload.draftId))
  const o = parseListenOrigin(task?.origin)
  if (!task || !draft || !o || !SELF_REPLY_PLATFORMS.includes(o.platform)) return { status: 'skipped', summary: 'Keine Listening-Antwort' }
  if (draft.status !== 'freigegeben' || task.status !== 'freigegeben') return { status: 'skipped', summary: 'Entwurf oder Aufgabe wurde inzwischen geändert' }
  const [project] = task.projectId ? await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)) : []
  if (!project || !task.targetUrl) return { status: 'skipped', summary: 'Projekt oder Ziel fehlt' }
  const label = LABELS[o.platform]
  const cap = o.kind === 'search' ? SEARCH_PER_DAY : o.kind === 'conversation' ? CONVO_PER_DAY : MENTION_PER_DAY
  if (await repliedSince(db, project.id, o.platform, o.kind, await dayStart(ws)) >= cap) {
    const next = zonedToUtc(addDays(today(ws.timezone), 1), '09:00', ws.timezone)
    await enqueueJob(db, 'listening_reply', { workspaceId: ws.id, payload, dedupeKey: `listening_reply:${draft.id}:${next.toISOString().slice(0, 10)}`, runAt: next, maxAttempts: 1 })
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Heute schon ${cap} Antworten auf ${label}: Diese geht morgen raus.`, createdAt: now() })
    return { status: 'skipped', summary: `Tageslimit ${label} erreicht, morgen` }
  }
  const conn = projectConns(ws, project, o.platform as 'bluesky' | 'mastodon')[0]
  const creds = conn ? openCreds(ws.id, conn) : null
  if (!conn || !creds) {
    await backToHuman(db, ws, task, draft.id, `${label}-Konto im Projekt nicht verbunden`)
    return { status: 'skipped', summary: `${label}-Konto fehlt` }
  }
  const internal = internalTextProblems([draft.body])
  if (internal.length) {
    await backToHuman(db, ws, task, draft.id, internal.join('; '))
    return { status: 'skipped', summary: `Nicht geantwortet: ${internal.join('; ')}` }
  }
  if (!ws.settings?.publishLive) {
    await db.transaction(async (tx) => {
      await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Trockenlauf: würde jetzt auf ${label} antworten (${task.targetUrl}). "Posten nach außen" ist aus, es wurde nichts gesendet.`, createdAt: now() })
      await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'social_dry_run', detail: { title: task.title, platforms: [o.platform] }, at: now() })
    })
    return { status: 'ok', summary: `Trockenlauf: würde auf ${label} antworten` }
  }
  let url: string
  try {
    url = o.platform === 'bluesky' ? await bskyReply(conn, creds, task.targetUrl, draft.body, f) : await mastoReply(conn, creds, task.targetUrl, draft.body, f, draft.id)
  }
  catch (err) {
    const msg = (err as Error).message.slice(0, 400)
    if (err instanceof PlatformError && (err.status === 401 || err.status === 403)) await markConnection(db, ws.id, conn.id, { error: msg, checkedAt: new Date().toISOString() })
    await backToHuman(db, ws, task, draft.id, msg)
    return { status: 'error', summary: `Antworten fehlgeschlagen: ${msg}` }
  }
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    if (cur && cur.status !== 'erledigt') await updateTask(tx, cur, { status: 'erledigt', postedUrl: url }, { type: 'agent' })
    await addTaskLinks(tx, task, [{ platform: o.platform, url }])
    await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Geantwortet auf ${label}: ${url}`, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'social_posted', detail: { title: task.title, platforms: [o.platform], urls: [url], listening: true }, at: now() })
  })
  return { status: 'ok', summary: `Geantwortet auf ${label}: ${url}` }
}

export async function runListeningReply(db: Db, ws: Workspace, payload: { taskId: string, draftId: string }, f?: FetchLike): Promise<RunOutcome> {
  const [t] = await db.select({ projectId: schema.tasks.projectId }).from(schema.tasks).where(eq(schema.tasks.id, payload.taskId))
  return withRun(db, ws, 'listening_reply', { projectId: t?.projectId ?? null, taskId: payload.taskId }, async () => sendListeningReply(db, ws, payload, f))
}

// Bericht: Antworten aus Social Listening und Klicks über ihre UTM-Links.

export async function listeningSummary(db: Db, projectId: string, from: string, to: string, timezone: string): Promise<{ replies: number, clicks: number } | null> {
  const start = zonedToUtc(from, '00:00', timezone)
  const end = zonedToUtc(addDays(to, 1), '00:00', timezone)
  const rows = await db.select({ code: schema.tasks.code, doneAt: schema.tasks.doneAt }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), like(schema.tasks.origin, 'listening:%'), eq(schema.tasks.status, 'erledigt')))
  const replies = rows.filter(r => r.doneAt && r.doneAt >= start && r.doneAt < end).length
  if (!rows.length) return null
  const codes = rows.map(r => r.code.toLowerCase())
  const [c] = await db.select({ n: sql<number>`coalesce(sum(${schema.utmStats.visits}), 0)::int` }).from(schema.utmStats)
    .where(and(eq(schema.utmStats.projectId, projectId), sql`${schema.utmStats.day} between ${from} and ${to}`, sql`lower(${schema.utmStats.campaign}) in (${sql.join(codes.map(x => sql`${x}`), sql`, `)})`))
  return { replies, clicks: c?.n ?? 0 }
}
