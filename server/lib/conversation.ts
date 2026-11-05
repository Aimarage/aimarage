import { and, eq, gte, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import { isPlatformBlocked } from '../../shared/utils/blocked-platforms'
import { CONVO_PLATFORMS, convoPlatformsOf, listenOrigin, parseListenOrigin, type ConvoPlatform } from '../../shared/utils/listening'
import { langName, langRule, medianLength, postLang, targetLength, toneProblems, toneRules, wrongLang } from '../../shared/utils/convo-tone'
import { listenSourceLines } from '../../shared/utils/reply-source'
import type { ListenVoice, ProjectListening } from '../db/schema'
import { withRules } from '../prompts/de'
import { logActivity } from './activity'
import { workspaceLlm, type RunContext } from './agent'
import { reviewerFrom, toneReview } from './ai-reviewer'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { strongModelAllowed } from './limits'
import { chatJson, writerFrom, type ChatMessage, type LlmConfig } from './llm'
import { broadTerm, bskyHit, finishReply, getJson, getList, htmlText, LABELS, MAX_CHARS, mastoHit, normUrl, patchListening, replyFits, type ListenDeps, type ListenHit, type OwnIds, type Taken } from './listening'
import { braveKey, braveSearch, siteQuery, type BraveResult } from './platforms/brave'
import { timeoutSignal } from './platforms/types'
import { socialTarget, zonedToUtc } from './publish'
import { activeChannels } from './where'
import { pagesIndex, projectPages, relevantPages } from './site-pages'
import { createTask } from './tasks'

// Mitreden: Aimarage findet frische, reichweitenstarke Beiträge anderer in der Nische (Vorbilder und Nischenbegriffe)
// und schlägt kurze, echte Kommentare vor. Nie ohne Freigabe; X, Threads, TikTok und YouTube postet immer der Mensch.

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>
type Json = Record<string, unknown>

export const CONVO_PER_DAY = 4
export const CONVO_YOUTUBE_PER_DAY = 1
export const CONVO_AUTHOR_DAYS = 14
export const CONVO_MAX_AGE_H = 36
export const CONVO_ROOM = 300
export const VOICES_DAYS = 7
export const VOICES_MAX = 50
const FIT_MAX = 12
const PUBLIC_BSKY = 'https://public.api.bsky.app'
const BRAVE_SITE: Record<'x' | 'threads' | 'tiktok', string> = { x: 'x.com', threads: 'threads.com', tiktok: 'tiktok.com' }
export const SELF_POST: ConvoPlatform[] = ['x', 'threads', 'tiktok', 'youtube']

export const CONVO_SYSTEM = `Du schreibst kurze Kommentare unter Beiträge anderer in den sozialen Medien, im Namen der Person bzw. Band hinter einem Projekt. Ziel: ehrlich mitreden wie ein Fan oder Kollege, nicht werben und nicht belehren.
- Ehrlich: nur Tatsachen aus den Projektdaten, nichts erfinden, keine erfundenen Erlebnisse.
- Immer in der Sprache des Beitrags, nie in der Sprache dieser Anweisungen.
- Nur normale Bindestriche (-), keine langen Gedankenstriche.`

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
}

function arr(v: unknown): Json[] {
  return Array.isArray(v) ? v.map(obj) : []
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

const dash = (s: string) => s.replace(/[\u2013\u2014]/g, '-')

// Lesen: Bluesky (öffentliche API), Mastodon (öffentliche Endpunkte der Heimat-Instanz), YouTube (RSS), X/Threads/TikTok (Brave).

function bskyStats(p: Json): ListenHit['stats'] {
  return { followers: null, likes: num(p.likeCount), replies: num(p.replyCount), reposts: num(p.repostCount) + num(p.quoteCount), views: null }
}

function bskyConvo(p: Json): ListenHit | null {
  const h = bskyHit(p, 'conversation')
  if (!h || h.parent) return null
  h.stats = bskyStats(p)
  return h
}

export async function bskyVoicePosts(actor: string, f: FetchLike): Promise<ListenHit[]> {
  const d = await getJson(f, 'Bluesky', `${PUBLIC_BSKY}/xrpc/app.bsky.feed.getAuthorFeed?${new URLSearchParams({ actor, filter: 'posts_no_replies', limit: '8' })}`)
  return arr(d.feed).filter(x => !x.reason).map(x => bskyConvo(obj(x.post))).filter((h): h is ListenHit => !!h)
}

export async function bskyTop(q: string, since: string, f: FetchLike, auth: { base: string, jwt: string } | null): Promise<ListenHit[]> {
  const params = new URLSearchParams({ q, sort: 'top', since, limit: '25' })
  const d = await getJson(f, 'Bluesky-Suche', `${auth ? auth.base : PUBLIC_BSKY}/xrpc/app.bsky.feed.searchPosts?${params}`, auth ? { Authorization: `Bearer ${auth.jwt}` } : {})
  return arr(d.posts).map(bskyConvo).filter((h): h is ListenHit => !!h)
}

export async function bskyProfiles(actors: string[], f: FetchLike): Promise<Map<string, { did: string, handle: string, name: string, followers: number }>> {
  const out = new Map<string, { did: string, handle: string, name: string, followers: number }>()
  for (let i = 0; i < actors.length; i += 25) {
    const qs = actors.slice(i, i + 25).map(a => `actors=${encodeURIComponent(a)}`).join('&')
    const d = await getJson(f, 'Bluesky', `${PUBLIC_BSKY}/xrpc/app.bsky.actor.getProfiles?${qs}`)
    for (const p of arr(d.profiles)) {
      const v = { did: str(p.did), handle: str(p.handle), name: str(p.displayName), followers: num(p.followersCount) }
      out.set(v.handle.toLowerCase(), v)
      out.set(v.did, v)
    }
  }
  return out
}

export async function bskyActors(q: string, f: FetchLike): Promise<{ did: string, handle: string, name: string, followers: number }[]> {
  const d = await getJson(f, 'Bluesky', `${PUBLIC_BSKY}/xrpc/app.bsky.actor.searchActors?${new URLSearchParams({ q, limit: '25' })}`)
  const want = q.toLowerCase().split(/\s+/).filter(w => w.length >= 2)
  return arr(d.actors).filter((p) => {
    const about = `${str(p.handle)} ${str(p.displayName)} ${str(p.description)}`.toLowerCase()
    return want.every(w => about.includes(w))
  }).map(p => ({ did: str(p.did), handle: str(p.handle), name: str(p.displayName), followers: num(p.followersCount) })).filter(a => a.did && a.handle)
}

export async function bskyComments(uri: string, f: FetchLike): Promise<string[]> {
  const d = await getJson(f, 'Bluesky', `${PUBLIC_BSKY}/xrpc/app.bsky.feed.getPostThread?${new URLSearchParams({ uri, depth: '1', parentHeight: '0' })}`)
  return arr(obj(d.thread).replies).map(r => str(obj(obj(r.post).record).text).trim()).filter(Boolean).slice(0, 20)
}

function mastoStats(s: Json): ListenHit['stats'] {
  return { followers: num(obj(s.account).followers_count) || null, likes: num(s.favourites_count), replies: num(s.replies_count), reposts: num(s.reblogs_count), views: null }
}

function mastoConvo(s: Json, base: string): ListenHit | null {
  const h = mastoHit(s, 'conversation', base)
  if (!h || h.parent) return null
  h.stats = mastoStats(s)
  return h
}

export function splitAcct(handle: string): { user: string, host: string } | null {
  const m = /^@?([\w.-]+)@([\w.-]+\.[a-z]{2,})$/i.exec(handle.trim())
  return m ? { user: m[1]!, host: m[2]!.toLowerCase() } : null
}

export async function mastoLookup(handle: string, f: FetchLike): Promise<{ id: string, followers: number, name: string, bot: boolean } | null> {
  const a = splitAcct(handle)
  if (!a) return null
  try {
    const d = await getJson(f, 'Mastodon', `https://${a.host}/api/v1/accounts/lookup?${new URLSearchParams({ acct: a.user })}`)
    return str(d.id) ? { id: str(d.id), followers: num(d.followers_count), name: str(d.display_name), bot: d.bot === true } : null
  }
  catch {
    return null
  }
}

export async function mastoVoicePosts(handle: string, id: string, f: FetchLike): Promise<ListenHit[]> {
  const a = splitAcct(handle)
  if (!a) return []
  const base = `https://${a.host}`
  const list = await getList(f, 'Mastodon', `${base}/api/v1/accounts/${encodeURIComponent(id)}/statuses?exclude_replies=true&exclude_reblogs=true&limit=8`)
  return list.map(s => mastoConvo(s, base)).filter((h): h is ListenHit => !!h)
}

export async function mastoTagPosts(base: string, tag: string, f: FetchLike): Promise<ListenHit[]> {
  const list = await getList(f, 'Mastodon-Hashtag', `${base}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=20`)
  return list.map(s => mastoConvo(s, base)).filter((h): h is ListenHit => !!h)
}

export function mastoStatusRef(url: string): { host: string, id: string } | null {
  const m = /^https:\/\/([^/]+)\/(?:@[^/]+|users\/[^/]+\/statuses)\/(\d+)/.exec(url)
  return m ? { host: m[1]!, id: m[2]! } : null
}

export async function mastoComments(url: string, f: FetchLike): Promise<string[]> {
  const r = mastoStatusRef(url)
  if (!r) return []
  const d = await getJson(f, 'Mastodon', `https://${r.host}/api/v1/statuses/${r.id}/context`)
  return arr(d.descendants).filter(s => str(s.in_reply_to_id) === r.id).map(s => htmlText(str(s.content)).replace(/^(@\S+\s+)+/, '').trim()).filter(Boolean).slice(0, 20)
}

export async function ytChannelId(handle: string, f: FetchLike): Promise<string | null> {
  const h = handle.replace(/^@/, '').trim()
  if (!/^[\w.-]{3,40}$/.test(h)) return null
  try {
    const res = await f(`https://www.youtube.com/@${encodeURIComponent(h)}`, { method: 'GET', headers: { 'Accept': 'text/html', 'Accept-Language': 'en', 'Cookie': 'SOCS=CAI' }, signal: timeoutSignal(15_000) })
    if (!res.ok) return null
    const html = await res.text()
    return /"(?:externalId|channelId)":"(UC[\w-]{22})"/.exec(html)?.[1] ?? /youtube\.com\/channel\/(UC[\w-]{22})/.exec(html)?.[1] ?? null
  }
  catch {
    return null
  }
}

function xmlText(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'').trim()
}

export function parseYtFeed(xml: string, handle: string): ListenHit[] {
  const out: ListenHit[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!
    const id = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(e)?.[1]
    if (!id) continue
    const title = xmlText(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? '')
    const desc = xmlText(/<media:description>([\s\S]*?)<\/media:description>/.exec(e)?.[1] ?? '')
    const views = Number(/<media:statistics views="(\d+)"/.exec(e)?.[1] ?? Number.NaN)
    const likes = Number(/<media:starRating count="(\d+)"/.exec(e)?.[1] ?? 0)
    const name = xmlText(/<author>\s*<name>([\s\S]*?)<\/name>/.exec(e)?.[1] ?? '')
    const channel = /<yt:channelId>(UC[\w-]{22})<\/yt:channelId>/.exec(e)?.[1] ?? ''
    out.push({
      platform: 'youtube',
      kind: 'conversation',
      key: `youtube:${id}`,
      url: `https://www.youtube.com/watch?v=${id}`,
      author: handle.replace(/^@/, ''),
      authorId: channel || handle,
      name,
      text: [title, oneLine(desc, 500)].filter(Boolean).join('\n'),
      at: /<published>([^<]+)<\/published>/.exec(e)?.[1] ?? '',
      root: `youtube:${id}`,
      lang: null,
      bot: false,
      title,
      stats: { followers: null, likes: Number.isFinite(likes) ? likes : 0, replies: 0, reposts: 0, views: Number.isFinite(views) ? views : null },
    })
  }
  return out
}

export async function ytVoicePosts(channelId: string, handle: string, f: FetchLike): Promise<ListenHit[]> {
  const res = await f(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { method: 'GET', headers: { Accept: 'application/atom+xml' }, signal: timeoutSignal(15_000) })
  if (!res.ok) return []
  return parseYtFeed(await res.text(), handle).slice(0, 5)
}

const BRAVE_POST: Record<'x' | 'threads' | 'tiktok', RegExp> = {
  x: /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i,
  threads: /^https:\/\/(?:www\.)?threads\.(?:net|com)\/@([\w.]+)\/post\/([\w-]+)/i,
  tiktok: /^https:\/\/(?:www\.)?tiktok\.com\/@([\w.-]+)\/video\/(\d+)/i,
}

export function braveConvoHit(platform: 'x' | 'threads' | 'tiktok', r: BraveResult): ListenHit | null {
  const m = BRAVE_POST[platform].exec(r.url)
  if (!m) return null
  const [, handle, id] = m as unknown as [string, string, string]
  if (['i', 'search', 'hashtag', 'explore'].includes(handle.toLowerCase())) return null
  const url = platform === 'x' ? `https://x.com/${handle}/status/${id}` : platform === 'threads' ? `https://www.threads.com/@${handle}/post/${id}` : `https://www.tiktok.com/@${handle}/video/${id}`
  const text = [r.title.replace(/\s+(on X|auf X|\| TikTok|on Threads|\(@[\w.]+\) on Threads)\b.*$/i, '').replace(/^.{0,60}? on X: /i, '').replace(/^["“]|["”]$/g, ''), r.snippet].filter(Boolean).join('\n').trim()
  return { platform, kind: 'conversation', key: `${platform}:${id}`, url, author: handle, authorId: handle.toLowerCase(), name: handle, text, at: r.publishedAt ?? '', root: `${platform}:${id}`, lang: null, bot: /bot$/i.test(handle), stats: null }
}

// Vorbilder: reichweitenstarke Accounts der Nische, wöchentlich neu (gesperrte, angeheftete und von Hand ergänzte bleiben).

const voicesSchema = z.object({ voices: z.array(z.object({ platform: z.string().catch(''), handle: z.string().catch(''), name: z.string().nullable().optional().catch(null) })).catch([]) })

export function voicesPrompt(project: Project, platforms: ConvoPlatform[]): string {
  const a = project.setup?.analysis
  return [
    'Nenne reichweitenstarke Accounts aus der Nische dieses Projekts, unter deren Beiträgen echte Gespräche stattfinden und wo ein kurzer, ehrlicher Kommentar von uns natürlich wirkt (Creator, Fachleute, Künstler, Magazine, Communities, gern auch die bekannten Konkurrenten).',
    '',
    `Projekt: ${project.name}${project.url ? ` (${project.url})` : ''}`,
    project.description ? `Beschreibung: ${project.description}` : '',
    a?.positioning ? `Positionierung: ${a.positioning}` : '',
    a?.audiences?.length ? `Zielgruppen: ${a.audiences.join('; ')}` : '',
    a?.competitors?.length ? `Konkurrenz: ${a.competitors.map(c => c.name).join(', ')}` : '',
    a?.keywords?.length ? `Stichworte: ${a.keywords.join(', ')}` : '',
    `Sprachen: ${project.languages.join(', ')}`,
    '',
    `Regeln: 20 bis 40 Accounts insgesamt, je Plattform 5 bis 10, auf diesen Plattformen: ${platforms.join(', ')}. Nur Accounts, die es sicher gibt und die aktiv sind, und die fast nur über das Thema der Nische posten. Keine allgemeinen Prominenten oder Plattform-Gründer, deren Beiträge meist nichts mit dem Projektthema zu tun haben. Keine Accounts, die nur allgemein über KI, LLMs, Tech, Open Source oder Self-Hosting posten, wenn das Projekt nicht genau das ist: Eine Technik, die das Projekt nutzt oder anbietet (z.B. ein MCP-Server), macht deren Szene nicht zur Nische. Keine Bots, keine reinen News- oder Link-Feeds, nicht das Projekt selbst.`,
    'Handle-Format: bluesky "name.bsky.social" oder Domain-Handle; mastodon "user@instanz"; x, threads, tiktok und youtube der Handle ohne @.',
    '',
    'Antworte nur mit JSON: {"voices": [{"platform": "bluesky", "handle": "...", "name": "..."}]}',
  ].filter(Boolean).join('\n')
}

export function cleanHandle(platform: ConvoPlatform, raw: string): string | null {
  let h = raw.trim().replace(/^https?:\/\/\S+?\/(@|profile\/)?/i, '').replace(/^@/, '').replace(/[/?#].*$/, '')
  if (platform === 'mastodon') return splitAcct(h) ? h.toLowerCase() : null
  if (platform === 'bluesky') {
    h = h.toLowerCase()
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null
  }
  if (platform === 'x') return /^\w{1,15}$/.test(h) ? h : null
  return /^[\w.-]{2,40}$/.test(h) ? h : null
}

export function voiceKey(v: Pick<ListenVoice, 'platform' | 'handle'>): string {
  return `${v.platform}:${v.handle.toLowerCase()}`
}

export function mergeVoices(old: ListenVoice[], fresh: ListenVoice[], max = VOICES_MAX): ListenVoice[] {
  const keep = old.filter(v => v.pinned || v.blocked || v.source === 'hand')
  const seen = new Set(keep.map(voiceKey))
  const add: ListenVoice[] = []
  for (const v of fresh) {
    const k = voiceKey(v)
    if (seen.has(k)) continue
    seen.add(k)
    add.push(v)
  }
  add.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
  const room = Math.max(0, max - keep.filter(v => !v.blocked).length)
  return [...keep, ...add.slice(0, room)]
}

function voicesFresh(st: ProjectListening, at: number): boolean {
  const v = st.voices
  return !!v?.at && !!v.list.length && Date.parse(v.at) > at - VOICES_DAYS * 86_400_000
}

export async function refreshVoices(db: Db, ws: Workspace, project: Project, platforms: ConvoPlatform[], o: { llm: LlmConfig, deps: ListenDeps, ctx: RunContext, terms: string[] }): Promise<ListenVoice[]> {
  const st = project.setup?.listening ?? {}
  const old = st.voices?.list ?? []
  if (voicesFresh(st, now().getTime()) || !platforms.length) return old
  const f = o.deps.fetch ?? fetch
  const res = await chatJson(o.llm, { messages: [{ role: 'system', content: 'Du kennst die Social-Media-Szene vieler Nischen. Du antwortest nur mit JSON.' }, { role: 'user', content: voicesPrompt(project, platforms) }], maxTokens: 1800, fast: true }, voicesSchema, o.deps.llmFetch)
  o.ctx.usage.push(...res.usage)
  const comp = new Set((project.setup?.analysis?.competitors ?? []).map(c => c.name.toLowerCase()))
  const cand: ListenVoice[] = []
  for (const r of res.data.voices) {
    const platform = r.platform.toLowerCase() as ConvoPlatform
    if (!platforms.includes(platform)) continue
    const handle = cleanHandle(platform, r.handle)
    if (!handle) continue
    cand.push({ platform, handle, name: r.name?.trim() || null, followers: null, source: r.name && comp.has(r.name.toLowerCase()) ? 'analyse' : 'ki' })
  }
  const fresh: ListenVoice[] = []
  const bsky = cand.filter(v => v.platform === 'bluesky')
  if (bsky.length) {
    try {
      const prof = await bskyProfiles(bsky.map(v => v.handle), f)
      for (const v of bsky) {
        const p = prof.get(v.handle)
        if (p && p.followers >= 100) fresh.push({ ...v, id: p.did, name: v.name ?? (p.name || null), followers: p.followers })
      }
    }
    catch (err) {
      o.ctx.log.push(`${project.name}: Bluesky-Vorbilder nicht geprüft: ${(err as Error).message.slice(0, 160)}`)
    }
  }
  if (platforms.includes('bluesky')) {
    const have = new Set(fresh.map(v => v.handle))
    for (const q of o.terms.slice(0, 2)) {
      try {
        const actors = (await bskyActors(q, f)).filter(a => !have.has(a.handle))
        const prof = actors.length ? await bskyProfiles(actors.map(a => a.did), f) : new Map()
        const found = actors.map(a => ({ ...a, followers: prof.get(a.did)?.followers ?? 0 })).filter(a => a.followers >= 300).sort((a, b) => b.followers - a.followers).slice(0, 5)
        for (const a of found) {
          have.add(a.handle)
          fresh.push({ platform: 'bluesky', handle: a.handle, id: a.did, name: a.name || null, followers: a.followers, source: 'suche' })
        }
      }
      catch (err) {
        o.ctx.log.push(`${project.name}: Bluesky-Vorbilder nicht gesucht: ${(err as Error).message.slice(0, 160)}`)
      }
    }
  }
  for (const v of cand.filter(x => x.platform === 'mastodon').slice(0, 15)) {
    const a = await mastoLookup(v.handle, f)
    if (a && !a.bot && a.followers >= 100) fresh.push({ ...v, id: a.id, name: v.name ?? (a.name || null), followers: a.followers })
  }
  for (const v of cand.filter(x => x.platform === 'youtube').slice(0, 10)) {
    const id = await ytChannelId(v.handle, f)
    if (id) fresh.push({ ...v, id })
  }
  fresh.push(...cand.filter(v => v.platform === 'x' || v.platform === 'threads' || v.platform === 'tiktok'))
  const list = mergeVoices(old, fresh)
  await patchListening(db, project.id, { voices: { list, at: now().toISOString() } })
  o.ctx.log.push(`${project.name}: ${list.filter(v => !v.blocked).length} Vorbilder (${CONVO_PLATFORMS.map(p => `${LABELS[p]} ${list.filter(v => v.platform === p && !v.blocked).length}`).join(', ')})`)
  return list
}

// Plattformen je Projekt: ausdrücklich gesetzt gilt; sonst nur, wo das Projekt ein Konto oder einen Kanal in der Strategie hat.

const PRESENT: Record<ConvoPlatform, RegExp> = { bluesky: /bluesky|bsky/i, mastodon: /mastodon/i, x: /(^|[\s/(,])X($|[\s/),:])|twitter|x\.com/, threads: /threads/i, tiktok: /tiktok/i, youtube: /youtube/i }

export async function convoEffective(db: DbOrTx, ws: Workspace, project: Project): Promise<Record<ConvoPlatform, boolean>> {
  const set = project.setup?.listening?.convo ?? {}
  const base = convoPlatformsOf(project.setup)
  const accounts = new Set<string>(socialTarget(ws, project)?.platforms.map(p => p.platform) ?? [])
  const chans = (await activeChannels(db, [project.id])).get(project.id) ?? []
  const named = chans.map(c => `${c.name} ${(c.places ?? []).join(' ')}`).join(' | ')
  return Object.fromEntries(CONVO_PLATFORMS.map(p => [p, !isPlatformBlocked(project, p) && (typeof set[p] === 'boolean' ? set[p]! : base[p] && (accounts.has(p) || PRESENT[p].test(named)))])) as Record<ConvoPlatform, boolean>
}

// Auswahl: Reichweite, Frische, Platz in der Diskussion.

export function convoScore(h: ListenHit, at: number): number {
  const t = Date.parse(h.at)
  const ageH = Number.isNaN(t) ? 12 : Math.max(0.5, (at - t) / 3_600_000)
  const s = h.stats
  const followers = s?.followers ?? (h.voice ? 5000 : 300)
  const eng = (s?.likes ?? 0) + 2 * (s?.replies ?? 0) + 2 * (s?.reposts ?? 0) + (s?.views ?? 0) / 100
  const perHour = eng / Math.max(ageH, 1)
  const reach = Math.log10(followers + 10) + 1.5 * Math.log10(perHour + 1)
  const fresh = ageH <= 6 ? 1.5 : ageH <= 12 ? 1.1 : ageH <= 24 ? 0.6 : 0.3
  return reach * fresh + (h.voice === 'pin' ? 2 : h.voice ? 1 : 0)
}

export interface ConvoFilter {
  taken: Taken
  seen: Set<string>
  own: OwnIds
  at: number
  recentAuthors: Set<string>
  blocked: Set<string>
  projectName: string
  languages?: string[]
}

export function convoFilter(hits: ListenHit[], o: ConvoFilter): ListenHit[] {
  const out: ListenHit[] = []
  const keys = new Set<string>()
  const authors = new Set<string>()
  const ownName = o.projectName.toLowerCase()
  for (const h of hits) {
    const author = `${h.platform}:${h.author.toLowerCase()}`
    const t = Date.parse(h.at)
    if (keys.has(h.key) || o.seen.has(h.key) || o.taken.urls.has(normUrl(h.url)) || o.taken.roots.has(h.root)) continue
    if (Number.isNaN(t) ? h.platform === 'bluesky' || h.platform === 'mastodon' : o.at - t > CONVO_MAX_AGE_H * 3_600_000) continue
    if (h.platform === 'bluesky' && (o.own.bluesky.has(h.authorId) || o.own.bluesky.has(h.author))) continue
    if (h.platform === 'mastodon' && o.own.mastodon.has(h.author.toLowerCase())) continue
    if (h.bot || !h.text.trim() || h.text.trim().length < 20) continue
    if ((h.stats?.replies ?? 0) > CONVO_ROOM) continue
    if (o.recentAuthors.has(author) || o.blocked.has(author) || authors.has(author)) continue
    if (h.text.toLowerCase().includes(ownName)) continue
    if (o.languages?.length && h.lang && !o.languages.includes(h.lang.slice(0, 2).toLowerCase())) continue
    keys.add(h.key)
    authors.add(author)
    out.push(h)
  }
  return out
}

// Schnelles Modell, streng: Passt der Beitrag wirklich zum Thema des Projekts? Im Zweifel nein (lieber kein Vorschlag als ein irrelevanter).

const relevanceSchema = z.object({ items: z.array(z.object({ i: z.coerce.number(), relevant: z.boolean().catch(false), lang: z.string().nullable().optional().catch(null), why: z.string().catch('') })).catch([]) })

export type Relevance = z.infer<typeof relevanceSchema>['items'][number]

export function relevancePrompt(knowledge: string, hits: ListenHit[]): string {
  const list = hits.map((h, i) => `[${i}] ${LABELS[h.platform]}, @${h.author}:\n${oneLine(h.text, 500)}`).join('\n\n')
  return [
    knowledge,
    '',
    'Strenge Relevanzprüfung: Passt der Beitrag wirklich zum Thema dieses Projekts, also zum Produkt selbst, zu seiner Nische oder zu einem Problem, das es löst?',
    'Test: Jemand liest unseren Kommentar darunter, klickt auf unser Profil und sieht das Projekt. Versteht er sofort, warum wir gerade dort kommentiert haben? Nur dann "relevant": true.',
    'Nicht relevant: nur dieselbe große Kategorie (KI, LLMs, Tech, Open Source, Self-Hosting, Software allgemein, Musik allgemein), nur ein gemeinsames Schlagwort oder Hashtag, eine Technik, die das Projekt bloß nutzt oder anbietet (z.B. MCP), Preise, Hardware, Politik, Nachrichten.',
    'Beispiel: Projekt ist ein Lesezeichen-Manager mit MCP-Server, Beitrag über Preise von KI-Hardware oder lokale Sprachmodelle: relevant=false. Beitrag über das Wiederfinden gespeicherter Links: relevant=true.',
    'Im Zweifel relevant=false. "lang": Sprache des Beitrags als ISO-Code (z.B. "en", "de"). "why": ein kurzer Satz auf Deutsch.',
    '',
    'Beiträge:',
    list,
    '',
    'Antworte nur mit JSON: {"items": [{"i": 0, "relevant": false, "lang": "en", "why": "..."}]} mit einem Eintrag je Beitrag.',
  ].join('\n')
}

// Nur Beiträge mit klarem Ja; Sprache aus Metadaten bzw. Erkennung, sonst aus der Prüfung; unbekannt oder keine Projektsprache: raus.
export function relevantHits(hits: ListenHit[], items: Relevance[], languages: string[]): { keep: ListenHit[], dropped: { hit: ListenHit, why: string }[] } {
  const by = new Map(items.filter(x => x.i >= 0 && x.i < hits.length).map(x => [x.i, x]))
  const keep: ListenHit[] = []
  const dropped: { hit: ListenHit, why: string }[] = []
  for (const [i, h] of hits.entries()) {
    const r = by.get(i)
    if (r?.relevant !== true) {
      dropped.push({ hit: h, why: r?.why || 'keine klare Antwort der Prüfung' })
      continue
    }
    const guess = (r.lang ?? '').toLowerCase().slice(0, 2)
    const lang = h.lang ?? (/^[a-z]{2}$/.test(guess) ? guess : null)
    if (!lang) {
      dropped.push({ hit: h, why: 'Sprache unklar' })
      continue
    }
    if (languages.length && !languages.includes(lang)) {
      dropped.push({ hit: h, why: `Sprache ${lang} ist keine Projektsprache` })
      continue
    }
    keep.push({ ...h, lang })
  }
  return { keep, dropped }
}

// Schnelles Modell: Haben wir dazu etwas Echtes zu sagen?

const fitSchema = z.object({ items: z.array(z.object({ i: z.coerce.number(), ok: z.boolean().catch(false), angle: z.string().catch(''), reason: z.string().catch('') })).catch([]) })

export type Fit = z.infer<typeof fitSchema>['items'][number]

export function fitPrompt(knowledge: string, hits: ListenHit[], languages: string[]): string {
  const list = hits.map((h, i) => `[${i}] ${LABELS[h.platform]}, @${h.author}${h.name && h.name !== h.author ? ` (${h.name})` : ''}${h.lang ? `, Sprache ${h.lang}` : ''}:\n${oneLine(h.text, 500)}`).join('\n\n')
  return [
    knowledge,
    '',
    'Wir wollen unter Beiträgen anderer aus unserer Nische mitreden: ein kurzer, echter Kommentar wie von einem Fan oder Kollegen. Prüfe je Beitrag: Haben wir dazu etwas Echtes zu sagen? "ok" nur, wenn ALLES zutrifft:',
    '0. Der Beitrag handelt vom Thema des Projekts (Produkt, Nische oder ein Problem, das es löst), nicht nur von derselben großen Kategorie. Wer nach unserem Kommentar unser Profil anklickt, muss den Zusammenhang sofort sehen.',
    '1. Echter Beitrag einer Person, Band, Marke oder Community der Nische. Keine Werbung, kein Gewinnspiel, keine reine Linkschleuder, kein Streit, keine Politik, nichts Trauriges oder Heikles.',
    '2. Wir haben etwas Echtes: ehrliche Anerkennung für etwas Konkretes darin, eine eigene passende Erfahrung, die zu unseren Projektdaten passt, oder eine interessante Info. Nur "gleiches Thema" reicht nicht. Tipps, Ratschläge oder Warnungen zählen nicht.',
    '3. Ein Kommentar von uns wirkt dort natürlich, nicht wie Werbung.',
    `4. Sprache des Beitrags ist eine der Projektsprachen (${languages.join(', ')}).`,
    '"angle": ein Satz, was wir Echtes sagen würden. "reason": kurz, warum (nicht). Im Zweifel ok=false.',
    '',
    'Beiträge:',
    list,
    '',
    'Antworte nur mit JSON: {"items": [{"i": 0, "ok": true, "angle": "...", "reason": "..."}]} mit einem Eintrag je Beitrag.',
  ].join('\n')
}

// Kommentar: Opus schreibt drei kurze Fassungen, Regex-Bannliste und Ton-Prüfung sieben aus.

const convoSchema = z.object({ variants: z.array(z.string()).catch([]), skip: z.boolean().catch(false), why: z.string().catch('') })

export function convoPrompt(project: Project, hit: ListenHit, o: { angle: string, examples: string[], target: number, max: number, facts: string[], pages: string, tone: ProjectListening['tone'] }): string {
  const picked = (o.tone?.picked ?? []).slice(0, 5)
  const rejected = (o.tone?.rejected ?? []).slice(0, 5)
  return [
    `Projekt: ${project.name}${project.description ? ` - ${project.description}` : ''}`,
    project.tonality ? `Tonalität: ${project.tonality}` : '',
    o.facts.length ? `Fakten:\n${o.facts.map(f => `- ${f}`).join('\n')}` : '',
    o.pages ? `Projektwissen (Auszüge der eigenen Seiten):\n${o.pages}` : '',
    '',
    `Beitrag auf ${LABELS[hit.platform]} von @${hit.author}${hit.name && hit.name !== hit.author ? ` (${hit.name})` : ''}${hit.lang ? `, Sprache ${langName(hit.lang)}` : ''}:`,
    `"${oneLine(hit.text, 1200)}"`,
    o.examples.length ? `\nSo klingen die anderen Kommentare dort (Ton und Länge übernehmen, nicht den Inhalt):\n${o.examples.slice(0, 15).map(e => `- ${oneLine(e, 200)}`).join('\n')}` : '',
    '',
    `Was wir Echtes zu sagen haben: ${o.angle || 'selbst finden'}`,
    '',
    'Schreibe drei verschiedene kurze Kommentare darauf (verschiedene Einstiege, nicht drei Umformulierungen desselben Satzes):',
    ...toneRules('conversation'),
    hit.lang ? langRule(hit.lang) : '',
    `- Etwa ${o.target} Zeichen, höchstens ${o.max}.`,
    '- Die Projekt-Regeln (Persona, wer spricht, was nie genannt wird) sind verbindlich.',
    picked.length ? `Früher gewählt (so mag es der Mensch):\n${picked.map(p => `- "${oneLine(p.chosen, 200)}"`).join('\n')}` : '',
    rejected.length ? `Früher verworfen (so nicht):\n${rejected.map(r => `- "${oneLine(r.text, 200)}"${r.reason ? ` (${oneLine(r.reason, 120)})` : ''}`).join('\n')}` : '',
    '- Wenn wir nichts Echtes zu sagen haben, es heikel ist oder Regeln es verbieten: "skip": true und in "why" kurz warum.',
    '',
    'Antworte nur mit JSON: {"variants": ["...", "...", "..."], "skip": false, "why": ""}',
  ].filter(s => s !== '').join('\n')
}

export function cleanVariant(text: string, hit: ListenHit): string {
  const t = dash(text).trim().replace(/^["'„“]+|["'“”]+$/g, '').trim()
  return finishReply(t, hit, { link: null, siteHost: null, prelim: null })
}

export function checkVariants(list: string[], hit: ListenHit, o: { projectName: string, others: string[], max: number }): { ok: string[], bad: { text: string, problems: string[] }[] } {
  const ok: string[] = []
  const bad: { text: string, problems: string[] }[] = []
  for (const raw of list) {
    const text = cleanVariant(raw, hit)
    const body = hit.platform === 'mastodon' ? text.replace(/^@\S+\s*/, '') : text
    const wrong = wrongLang(body, hit.lang)
    const problems = [...toneProblems(body, { kind: 'conversation', projectName: o.projectName, others: o.others, maxLen: o.max }), ...(wrong ? [wrong] : [])]
    if (!problems.length && replyFits(text, hit.platform) && !ok.includes(text)) ok.push(text)
    else if (problems.length) bad.push({ text, problems })
  }
  return { ok, bad }
}

function reachLine(h: ListenHit, at: number): string {
  const s = h.stats
  const t = Date.parse(h.at)
  const ageH = Number.isNaN(t) ? null : Math.max(0, Math.round((at - t) / 3_600_000))
  const parts = [
    s?.followers ? `${s.followers.toLocaleString('de-DE')} Follower` : h.voice ? 'Vorbild' : '',
    s?.views ? `${s.views.toLocaleString('de-DE')} Aufrufe` : '',
    s?.likes ? `${s.likes} Likes` : '',
    s?.replies ? `${s.replies} Antworten` : '',
    ageH != null ? `vor ${ageH} Std.` : '',
  ].filter(Boolean)
  return parts.length ? `Reichweite: ${parts.join(', ')}` : ''
}

export function convoHowTo(platform: ConvoPlatform, handle: string | null): string {
  if (platform === 'youtube') return 'YouTube: nur ein Vorschlag, Aimarage kommentiert dort nie selbst. "Kopieren und öffnen", selbst kommentieren, danach "Erledigt" mit dem Link zu deinem Kommentar.'
  if (SELF_POST.includes(platform)) return `${LABELS[platform]} erlaubt Aimarage keine Antworten: "Kopieren und öffnen", selbst kommentieren, danach "Erledigt" mit dem Link zu deinem Kommentar.`
  return `Nach dem Freigeben antwortet Aimarage selbst${handle ? ` über ${handle}` : ''}.`
}

async function countSince(db: Db, projectId: string, pattern: string, since: Date): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), like(schema.tasks.origin, pattern), gte(schema.tasks.createdAt, since)))
  return r?.n ?? 0
}

export async function recentConvoAuthors(db: Db, workspaceId: string, at: number): Promise<Set<string>> {
  const rows = await db.select({ origin: schema.tasks.origin }).from(schema.tasks)
    .where(and(eq(schema.tasks.workspaceId, workspaceId), like(schema.tasks.origin, 'listening:%|conversation|%'), gte(schema.tasks.createdAt, new Date(at - CONVO_AUTHOR_DAYS * 86_400_000))))
  const out = new Set<string>()
  for (const r of rows) {
    const o = parseListenOrigin(r.origin)
    if (o?.author) out.add(`${o.platform}:${o.author.toLowerCase()}`)
  }
  return out
}

export function nicheTerms(project: Project, fallback: string[]): string[] {
  const kw = (project.setup?.analysis?.keywords ?? []).map(k => k.trim()).filter(k => k.length >= 3 && k.length <= 60 && !k.toLowerCase().includes(project.name.toLowerCase()))
  return [...new Set([...kw, ...fallback])].filter(t => !broadTerm(t)).slice(0, 6)
}

export interface ConvoContext {
  llm: LlmConfig
  deps: ListenDeps
  ctx: RunContext
  own: OwnIds
  taken: Taken
  seen: Set<string>
  facts: string[]
  handles: Partial<Record<ConvoPlatform, string>>
  bskyAuth: { base: string, jwt: string } | null
  mastoBase: string | null
  tags: string[]
  queries: string[]
}

export interface ConvoResult {
  found: number
  drafted: number
  judged: string[]
  errors: string[]
}

export async function converseProject(db: Db, ws: Workspace, project: Project, c: ConvoContext): Promise<ConvoResult> {
  const out: ConvoResult = { found: 0, drafted: 0, judged: [], errors: [] }
  const f = c.deps.fetch ?? fetch
  const at = now().getTime()
  const st = project.setup?.listening ?? {}
  const on = await convoEffective(db, ws, project)
  const platforms = CONVO_PLATFORMS.filter(p => on[p] && (p === 'bluesky' ? !!c.bskyAuth : p === 'mastodon' ? !!c.mastoBase : p === 'youtube' || !!braveKey(ws)))
  if (!platforms.length) return out
  const dayStart = zonedToUtc(today(ws.timezone), '00:00', ws.timezone)
  let left = CONVO_PER_DAY - await countSince(db, project.id, 'listening:%|conversation|%', dayStart)
  if (left <= 0) return out
  const tags = c.tags.filter(t => !broadTerm(t))
  const terms = nicheTerms(project, [...tags, ...c.queries])
  let voices: ListenVoice[] = st.voices?.list ?? []
  try {
    voices = await refreshVoices(db, ws, project, platforms, { llm: c.llm, deps: c.deps, ctx: c.ctx, terms })
  }
  catch (err) {
    out.errors.push(`${project.name}: Vorbilder nicht aktualisiert: ${(err as Error).message.slice(0, 200)}`)
  }
  const missing = voices.filter(v => !v.blocked && v.id === undefined && (v.platform === 'mastodon' || v.platform === 'youtube') && platforms.includes(v.platform)).slice(0, 5)
  if (missing.length) {
    for (const v of missing) {
      if (v.platform === 'mastodon') {
        const a = await mastoLookup(v.handle, f)
        Object.assign(v, a ? { id: a.id, followers: a.followers, name: v.name ?? (a.name || null) } : { id: null })
      }
      else v.id = await ytChannelId(v.handle, f)
    }
    await patchListening(db, project.id, { voices: { list: voices, at: voicesFresh(st, at) ? st.voices!.at : now().toISOString() } })
  }
  const active = voices.filter(v => !v.blocked && platforms.includes(v.platform))
  const voiceOf = new Map(active.map(v => [voiceKey(v), v]))
  const pick = (p: ConvoPlatform, n: number) => active.filter(v => v.platform === p).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.followers ?? 0) - (a.followers ?? 0)).slice(0, n)
  const hits: ListenHit[] = []
  const tryRead = async (label: string, fn: () => Promise<ListenHit[]>) => {
    try {
      hits.push(...await fn())
    }
    catch (err) {
      out.errors.push(`${project.name}: Mitreden ${label}: ${(err as Error).message.slice(0, 200)}`)
    }
  }
  const since = new Date(at - 24 * 3_600_000).toISOString()
  if (platforms.includes('bluesky')) {
    for (const v of pick('bluesky', 15)) await tryRead('Bluesky', () => bskyVoicePosts(v.id || v.handle, f).then(l => l.map(h => ({ ...h, stats: h.stats ? { ...h.stats, followers: v.followers ?? null } : null }))))
    for (const q of terms.slice(0, 2)) await tryRead('Bluesky', () => bskyTop(q, since, f, c.bskyAuth))
  }
  if (platforms.includes('mastodon')) {
    for (const v of pick('mastodon', 10)) if (v.id) await tryRead('Mastodon', () => mastoVoicePosts(v.handle, v.id!, f))
    for (const tag of tags.slice(0, 2)) await tryRead('Mastodon', () => mastoTagPosts(c.mastoBase!, tag, f))
  }
  if (platforms.includes('youtube')) {
    for (const v of pick('youtube', 8)) if (v.id) await tryRead('YouTube', () => ytVoicePosts(v.id!, v.handle, f))
  }
  const key = braveKey(ws)
  const day = today(ws.timezone)
  const braveP = (['x', 'threads', 'tiktok'] as const).filter(p => platforms.includes(p))
  if (key && braveP.length && st.braveDay !== day) {
    const n = Math.floor(at / 86_400_000)
    for (const p of braveP) {
      const qs = [terms.length ? siteQuery(BRAVE_SITE[p], terms[n % terms.length]!) : null]
      const vs = pick(p, 20)
      if (vs.length) qs.push(siteQuery(`${BRAVE_SITE[p]}/${p === 'x' ? '' : '@'}${vs[n % vs.length]!.handle}`, ''))
      for (const q of qs.filter((x): x is string => !!x)) await tryRead(LABELS[p], async () => (await braveSearch(key, q, f, { freshness: 'pd', count: 10, use: { ws: ws.id, project: project.id, purpose: 'listening' } })).map(r => braveConvoHit(p, r)).filter((h): h is ListenHit => !!h))
    }
    await patchListening(db, project.id, { braveDay: day })
  }
  for (const h of hits) {
    const v = voiceOf.get(`${h.platform}:${h.author.toLowerCase()}`)
    if (v) h.voice = v.pinned ? 'pin' : 'yes'
    h.lang = postLang(h.text, h.lang)
  }
  const blocked = new Set(voices.filter(v => v.blocked).map(voiceKey))
  const cand = convoFilter(hits, { taken: c.taken, seen: c.seen, own: c.own, at, recentAuthors: await recentConvoAuthors(db, ws.id, at), blocked, projectName: project.name, languages: project.languages })
    .map(h => ({ h, s: convoScore(h, at) })).sort((a, b) => b.s - a.s).map(x => x.h)
  const fromVoices = cand.filter(h => h.voice).slice(0, FIT_MAX / 2)
  const fromTerms = cand.filter(h => !h.voice).slice(0, FIT_MAX - fromVoices.length)
  cand.splice(0, cand.length, ...[...fromVoices, ...fromTerms].sort((a, b) => convoScore(b, at) - convoScore(a, at)))
  c.ctx.log.push(`${project.name}: Mitreden auf ${platforms.map(p => LABELS[p]).join(', ')}: ${hits.length} Beiträge gelesen, ${cand.length} in der Auswahl`)
  if (!cand.length) return out
  const pages = await projectPages(db, project.id).catch(() => [])
  const a = project.setup?.analysis
  const knowledge = [
    `Projekt: ${project.name}${project.url ? ` (${project.url})` : ''}`,
    project.description ? `Beschreibung: ${project.description}` : '',
    a?.positioning ? `Positionierung: ${a.positioning}` : '',
    a?.audiences?.length ? `Zielgruppen: ${a.audiences.join('; ')}` : '',
    c.facts.length ? `Fakten:\n${c.facts.slice(0, 20).map(x => `- ${x}`).join('\n')}` : '',
    pages.length ? `Seiten des Projekts:\n${pagesIndex(pages, 25)}` : '',
  ].filter(Boolean).join('\n')
  const relRes = await chatJson(c.llm, { messages: [{ role: 'system', content: 'Du prüfst streng, ob Social-Media-Beiträge wirklich zum Thema eines Projekts passen. Du antwortest nur mit JSON.' }, { role: 'user', content: relevancePrompt(knowledge, cand) }], maxTokens: 200 + cand.length * 60, fast: true }, relevanceSchema, c.deps.llmFetch)
  c.ctx.usage.push(...relRes.usage)
  const rel = relevantHits(cand, relRes.data.items, project.languages)
  out.judged.push(...rel.dropped.map(d => d.hit.key))
  c.ctx.log.push(`${project.name}: Mitreden-Relevanz: ${rel.keep.length} von ${cand.length} passen zum Projekt${rel.dropped.length ? ` (nicht: ${rel.dropped.slice(0, 3).map(d => `@${d.hit.author} ${oneLine(d.why, 80)}`).join('; ')})` : ''}`)
  cand.splice(0, cand.length, ...rel.keep)
  if (!cand.length) return out
  const fitRes = await chatJson(c.llm, { messages: [{ role: 'system', content: 'Du bewertest Social-Media-Beiträge für ein kleines Team, das ehrlich mitreden will. Du antwortest nur mit JSON.' }, { role: 'user', content: fitPrompt(knowledge, cand, project.languages) }], maxTokens: 300 + cand.length * 80, fast: true }, fitSchema, c.deps.llmFetch)
  c.ctx.usage.push(...fitRes.usage)
  out.judged.push(...cand.map(h => h.key))
  const fits = new Map(fitRes.data.items.filter(x => x.i >= 0 && x.i < cand.length).map(x => [x.i, x]))
  c.ctx.log.push(`${project.name}: Mitreden: ${[...fits.values()].filter(x => x.ok).length} von ${cand.length} passen${[...fits.values()].some(x => !x.ok) ? ` (nicht: ${[...fits.entries()].filter(([, x]) => !x.ok).slice(0, 3).map(([i, x]) => `@${cand[i]!.author} ${oneLine(x.reason, 80)}`).join('; ')})` : ''}`)
  const writer = c.deps.llm ? c.llm : writerFrom(workspaceLlm(ws, 'draft_social'), strongModelAllowed(ws))
  const checker = c.deps.llm ? c.llm : reviewerFrom(workspaceLlm(ws, 'draft_check'), strongModelAllowed(ws))?.cfg ?? c.llm
  const hourAgo = new Date(at - 3_600_000)
  const usedNow = new Set<ConvoPlatform>()
  let yt = await countSince(db, project.id, 'listening:youtube|conversation|%', dayStart)
  for (const [i, h] of cand.entries()) {
    const fit = fits.get(i)
    if (!fit?.ok || left <= 0) continue
    const p = h.platform as ConvoPlatform
    if (usedNow.has(p) || await countSince(db, project.id, `listening:${p}|conversation|%`, hourAgo) > 0) continue
    if (p === 'youtube' && yt >= CONVO_YOUTUBE_PER_DAY) continue
    out.found++
    const examples = await (p === 'bluesky' ? bskyComments(h.key, f) : p === 'mastodon' ? mastoComments(h.url, f) : Promise.resolve([])).catch(() => [] as string[])
    const sel = relevantPages(pages, h.text, 2500, { perPage: 800 })
    const ok = await draftConversation(db, ws, project, h, fit, { writer, checker, c, examples, pages: sel.map(x => `${x.page.title ?? x.page.url}: ${oneLine(x.text, 800)}`).join('\n'), at })
    if (ok) {
      out.drafted++
      left--
      usedNow.add(p)
      if (p === 'youtube') yt++
    }
  }
  return out
}

async function draftConversation(db: Db, ws: Workspace, project: Project, hit: ListenHit, fit: Fit, o: { writer: LlmConfig, checker: LlmConfig, c: ConvoContext, examples: string[], pages: string, at: number }): Promise<boolean> {
  const { c } = o
  const p = hit.platform as ConvoPlatform
  const label = LABELS[p]
  const { target, max } = targetLength(medianLength(o.examples), MAX_CHARS[p])
  const others = (project.setup?.analysis?.competitors ?? []).map(x => x.name)
  const messages: ChatMessage[] = [
    { role: 'system', content: withRules(CONVO_SYSTEM, project.rules) },
    { role: 'user', content: convoPrompt(project, hit, { angle: dash(fit.angle), examples: o.examples, target, max, facts: c.facts, pages: o.pages, tone: project.setup?.listening?.tone ?? null }) },
  ]
  const res = await chatJson(o.writer, { messages, maxTokens: 900 }, convoSchema, c.deps.llmFetch)
  c.ctx.usage.push(...res.usage)
  if (res.data.skip || !res.data.variants.length) {
    c.ctx.log.push(`${project.name}: Mitreden ${label} ${hit.url} ausgelassen: ${res.data.why || 'kein Text'}`)
    return false
  }
  let checked = checkVariants(res.data.variants, hit, { projectName: project.name, others, max })
  if (!checked.ok.length) {
    const fix = `Diese Fassungen gehen so nicht:\n${checked.bad.map(b => `- "${oneLine(b.text, 200)}": ${b.problems.join(', ')}`).join('\n')}\nSchreibe drei neue, kürzere und natürlichere Fassungen nach denselben Regeln${hit.lang ? `, auf ${langName(hit.lang)}` : ''}. Antworte nur mit JSON wie oben.`
    const again = await chatJson(o.writer, { messages: [...messages, { role: 'assistant', content: JSON.stringify(res.data) }, { role: 'user', content: fix }], maxTokens: 900 }, convoSchema, c.deps.llmFetch)
    c.ctx.usage.push(...again.usage)
    checked = again.data.skip ? { ok: [], bad: checked.bad } : checkVariants(again.data.variants, hit, { projectName: project.name, others, max })
  }
  if (!checked.ok.length) {
    c.ctx.log.push(`${project.name}: Mitreden ${label} ${hit.url} ausgelassen: Bannliste (${checked.bad.flatMap(b => b.problems).slice(0, 4).join(', ')})`)
    return false
  }
  const tone = await toneReview(o.checker, { platform: label, kind: 'conversation', author: hit.author, post: hit.text, examples: o.examples, variants: checked.ok, rules: project.rules, lang: hit.lang }, c.ctx.usage, c.ctx.log, c.deps.llmFetch)
  const good = tone.ok.map(i => checked.ok[i]!).filter(Boolean)
  if (!good.length) {
    c.ctx.log.push(`${project.name}: Mitreden ${label} ${hit.url} ausgelassen: Ton-Prüfung (${tone.reason || 'keine Fassung klingt echt'})`)
    return false
  }
  const self = SELF_POST.includes(p)
  const origin = listenOrigin({ platform: p, kind: 'conversation', author: hit.author, root: hit.root })
  const description = [
    ...listenSourceLines({ kind: 'conversation', author: hit.author, text: hit.text, url: hit.url, at: hit.at }),
    reachLine(hit, o.at),
    fit.angle ? `Warum: ${dash(fit.angle)}` : '',
    convoHowTo(p, c.handles[p] ?? null),
  ].filter(Boolean).join('\n')
  const lang = hit.lang ?? project.languages[0] ?? null
  const variants = Object.fromEntries(good.slice(1, 3).map((v, n) => [`alt-${n + 2}`, v]))
  return db.transaction(async (tx) => {
    const task = await createTask(tx, {
      workspaceId: ws.id,
      projectId: project.id,
      title: `${label}: Kommentar unter Beitrag von @${oneLine(hit.author, 40)}`,
      description,
      category: 'community',
      channel: label,
      language: lang,
      dueDate: today(ws.timezone),
      durationMin: self ? 3 : 2,
      status: 'entwurf_fertig',
      draftKind: 'text',
      targetUrl: hit.url,
      origin,
      humanStep: self ? 'Selbst kommentieren' : null,
    })
    await tx.insert(schema.drafts).values({ taskId: task.id, version: 1, kind: 'text', body: good[0]!, variants, targetUrl: hit.url, byAgent: true, aiGenerated: true, runId: c.ctx.runId, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: project.id, taskId: task.id, actor: 'agent', action: 'draft_created', detail: { title: task.title, listening: p, conversation: true }, at: now() })
    return true
  })
}

// Wahl einer anderen Fassung und Verwerfen: als Lehre für künftige Kommentare (je höchstens 12).

export const TONE_KEEP = 12

export async function rememberTone(db: DbOrTx, projectId: string, entry: { picked?: { chosen: string, others: string[] }, rejected?: { text: string, reason: string | null } }): Promise<void> {
  const [row] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, projectId))
  const cur = row?.setup?.listening?.tone ?? {}
  const at = now().toISOString()
  const tone = {
    picked: entry.picked ? [{ ...entry.picked, at }, ...(cur.picked ?? [])].slice(0, TONE_KEEP) : cur.picked ?? [],
    rejected: entry.rejected ? [{ ...entry.rejected, at }, ...(cur.rejected ?? [])].slice(0, TONE_KEEP) : cur.rejected ?? [],
  }
  await db.execute(sql`update projects set setup = jsonb_set(coalesce(setup, '{}'::jsonb), '{listening}', (case when jsonb_typeof(setup->'listening') = 'object' then setup->'listening' else '{}'::jsonb end) || ${JSON.stringify({ tone })}::jsonb) where id = ${projectId}`)
}
