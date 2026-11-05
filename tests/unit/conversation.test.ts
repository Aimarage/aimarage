import { and, eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upsertConnection, sealAppSecret } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { braveConvoHit, cleanHandle, convoEffective, convoFilter, convoScore, mergeVoices, parseYtFeed, rememberTone } from '../../server/lib/conversation'
import { runListening, type ListenHit } from '../../server/lib/listening'
import { replyAccount } from '../../server/lib/listen-account'
import { resetBraveState } from '../../server/lib/platforms/brave'
import { resetSecretCache } from '../../server/lib/secret'
import { applyDraftAction } from '../../server/services/drafts'
import { whereFor } from '../../server/lib/where'
import { medianLength, targetLength, toneProblems } from '../../shared/utils/convo-tone'
import { convoPlatformsOf, isConversationTask, listenOrigin, parseListenOrigin, repliesItself } from '../../shared/utils/listening'
import { parseListenDesc } from '../../shared/utils/reply-source'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let userId: string

const NOW = Date.parse('2026-10-30T10:00:00+01:00')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function post(rkey: string, handle: string, text: string, h: number, counts: { like?: number, reply?: number } = {}) {
  return { uri: `at://did:plc:${handle.split('.')[0]}/app.bsky.feed.post/${rkey}`, cid: `cid-${rkey}`, author: { did: `did:plc:${handle.split('.')[0]}`, handle, displayName: handle.split('.')[0] }, record: { text, createdAt: hoursAgo(h), langs: ['en'] }, indexedAt: hoursAgo(h), likeCount: counts.like ?? 0, replyCount: counts.reply ?? 0, repostCount: 0 }
}

const VOICE_FEED = [
  { post: post('v1', 'synthqueen.bsky.social', 'Finished a new darksynth track tonight, recorded the bass on an old Juno', 3, { like: 400, reply: 40 }) },
  { post: post('v2', 'synthqueen.bsky.social', 'Old post about my cat', 60, { like: 10 }) },
]

const YT_FEED = `<?xml version="1.0"?><feed><entry><yt:videoId>abcdefghijk</yt:videoId><yt:channelId>UCaaaaaaaaaaaaaaaaaaaaaa</yt:channelId><title>Making a darksynth track from scratch</title><published>${hoursAgo(5)}</published><author><name>Synth Channel</name></author><media:group><media:description>Full walkthrough</media:description><media:community><media:starRating count="900"/><media:statistics views="52000"/></media:community></media:group></entry></feed>`

const calls: string[] = []
const web = async (url: string, _init: RequestInit) => {
  calls.push(url)
  if (url.endsWith('createSession')) return json({ accessJwt: 'jwt', did: 'did:plc:own', handle: 'own.bsky.social' })
  if (url.includes('listNotifications')) return json({ notifications: [] })
  if (url.includes('searchPosts')) return json({ posts: [] })
  if (url.includes('getAuthorFeed')) return json({ feed: VOICE_FEED })
  if (url.includes('searchActors')) return json({ actors: [] })
  if (url.includes('getPostThread')) return json({ thread: { replies: [{ post: { record: { text: 'this is so good' } } }, { post: { record: { text: 'the bass!!' } } }, { post: { record: { text: 'Juno forever, mine still works after 30 years' } } }] } })
  if (url.includes('feeds/videos.xml')) return new Response(YT_FEED, { status: 200 })
  if (url.includes('api.search.brave.com')) return json({ web: { results: [{ url: 'https://x.com/retrowave_fm/status/123456', title: 'retrowave_fm on X: "New darksynth playlist is up"', description: 'New darksynth playlist is up, 40 tracks', page_age: hoursAgo(4) }] } })
  return json({ error: 'nope' }, 404)
}

const prompts: string[] = []
const llm = async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
  const p = body.messages.at(-1)!.content
  prompts.push(p)
  let reply: unknown = {}
  if (p.includes('Leite Suchbegriffe')) reply = { queries: ['darksynth recommendation'], tags: ['darksynth'] }
  else if (p.includes('Strenge Relevanzprüfung')) {
    const n = (p.match(/^\[\d+\]/gm) ?? []).length
    const off = [...p.matchAll(/^\[(\d+)\][^\n]*\n(.*)$/gm)].filter(m => /DGX|GPU|price/i.test(m[2]!)).map(m => Number(m[1]))
    reply = { items: Array.from({ length: n }, (_, i) => ({ i, relevant: !off.includes(i), lang: 'en', why: off.includes(i) ? 'KI-Hardwarepreise, nicht das Thema' : 'Darksynth' })) }
  }
  else if (p.includes('Haben wir dazu etwas Echtes zu sagen')) {
    const n = (p.match(/^\[\d+\]/gm) ?? []).length
    reply = { items: Array.from({ length: n }, (_, i) => ({ i, ok: true, angle: 'Wir nehmen selbst Darksynth auf und mögen analoge Bässe', reason: 'passt' })) }
  }
  else if (p.includes('Schreibe drei verschiedene kurze Kommentare')) {
    reply = { variants: ['Great point, love this!', 'oh the Juno bass, that sound never gets old', 'pass auf, dass niemand deinen Server hackt', 'Juno bass on darksynth just hits different'], skip: false }
  }
  else if (p.includes('Prüfe jede Fassung streng')) {
    const n = (p.match(/^\[\d+\]/gm) ?? []).length
    reply = { items: Array.from({ length: n }, (_, i) => ({ i, ai: false, lecture: false, real: true, sameLang: true, ok: true, why: 'klingt echt' })), best: n > 1 ? 1 : 0 }
  }
  return json({ model: 'mock', choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })
}

async function convoTasks() {
  return db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, project.id), like(schema.tasks.origin, 'listening:%|conversation|%'))).orderBy(schema.tasks.createdAt)
}

function hit(over: Partial<ListenHit> = {}): ListenHit {
  return { platform: 'bluesky', kind: 'conversation', key: 'k1', url: 'https://bsky.app/profile/a/post/1', author: 'a.bsky.social', authorId: 'did:a', name: 'A', text: 'A new synth track I made this week', at: hoursAgo(2), root: 'k1', lang: 'en', bot: false, stats: { followers: 1000, likes: 10, replies: 5, reposts: 0, views: null }, ...over }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-30T10:00:00+01:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  resetBraveState()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  userId = (await db.insert(schema.users).values({ email: 'p@example.com', name: 'Peter' }).returning())[0]!.id
  const voices = { at: hoursAgo(1), list: [
    { platform: 'bluesky' as const, handle: 'synthqueen.bsky.social', id: 'did:plc:synthqueen', followers: 25000, source: 'ki' as const },
    { platform: 'youtube' as const, handle: 'synthchannel', id: 'UCaaaaaaaaaaaaaaaaaaaaaa', followers: null, source: 'ki' as const },
    { platform: 'x' as const, handle: 'retrowave_fm', followers: null, source: 'ki' as const },
  ] }
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'visitors', name: 'The Wanderer', code: 'THE', icon: 'V', url: 'https://thewanderer.example', languages: ['en'], setup: { analysis: { keywords: ['darksynth'] }, listening: { voices, convo: { x: true, youtube: true, threads: false } } } }).returning())[0]!
  await upsertConnection(db, ws.id, { provider: 'bluesky', platform: 'bluesky', name: '@own.bsky.social', handle: 'own.bsky.social', ext: { did: 'did:plc:own' } }, { identifier: 'own.bsky.social', password: 'app-pass' }, { projectId: project.id })
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
  ws = (await db.update(schema.workspaces).set({ settings: { ...ws.settings, apps: { brave: { clientId: '', secret: sealAppSecret(ws.id, 'brave', 'brave-key') } } } }).where(eq(schema.workspaces.id, ws.id)).returning())[0]!
})

afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Ton', () => {
  it('Bannliste: KI-Floskeln, ungefragter Rat, Links, Hashtags, Aufzählung, Produktname', () => {
    expect(toneProblems('hey, das find ich cool', { kind: 'conversation' })).toEqual([])
    expect(toneProblems('Great point, thanks for sharing!', { kind: 'conversation' }).length).toBeGreaterThan(0)
    expect(toneProblems('Cooles Projekt, pass auf, dass niemand deinen Server hackt', { kind: 'conversation' })).toEqual(['ungefragter Rat "pass auf"'])
    expect(toneProblems('nice, see https://x.example #synth', { kind: 'conversation' })).toEqual(['Link', 'Hashtag'])
    expect(toneProblems('- eins\n- zwei', { kind: 'conversation' })).toContain('Aufzählung')
    expect(toneProblems('The Wanderer would love this', { kind: 'conversation', projectName: 'The Wanderer' })).toEqual(['Produktname "The Wanderer"'])
    expect(toneProblems('we made something similar as The Wanderer', { kind: 'conversation', projectName: 'The Wanderer' })).toEqual([])
    expect(toneProblems('I\'d recommend linkbox, I build it', { kind: 'search' })).toEqual([])
    expect(toneProblems('Was meint ihr?', { kind: 'mention' })).toHaveLength(1)
  })

  it('Ziellänge aus dem Median der echten Kommentare', () => {
    expect(medianLength(['ab', 'abcd', 'abcdef'])).toBe(4)
    expect(medianLength([])).toBeNull()
    expect(targetLength(30, 280)).toEqual({ target: 40, max: 90 })
    expect(targetLength(null, 280).target).toBe(110)
  })
})

describe('Bausteine', () => {
  it('Herkunft, Plattformen und Antwortweg', () => {
    const o = listenOrigin({ platform: 'youtube', kind: 'conversation', author: 'synthchannel', root: 'youtube:abc' })
    expect(parseListenOrigin(o)).toEqual({ platform: 'youtube', kind: 'conversation', author: 'synthchannel', root: 'youtube:abc' })
    expect(isConversationTask({ origin: o })).toBe(true)
    expect(repliesItself({ origin: o })).toBe(false)
    expect(repliesItself({ origin: listenOrigin({ platform: 'x', kind: 'conversation', author: 'a', root: 'b' }) })).toBe(false)
    expect(repliesItself({ origin: listenOrigin({ platform: 'bluesky', kind: 'conversation', author: 'a', root: 'b' }) })).toBe(true)
    expect(convoPlatformsOf({ listening: { convo: { tiktok: false } } })).toMatchObject({ bluesky: true, tiktok: false, youtube: true })
  })

  it('Reichweite und Frische zählen, alte, volle und gesperrte fallen raus', () => {
    const at = NOW
    expect(convoScore(hit({ at: hoursAgo(2) }), at)).toBeGreaterThan(convoScore(hit({ at: hoursAgo(20) }), at))
    expect(convoScore(hit({ stats: { followers: 50000, likes: 200, replies: 30, reposts: 5, views: null } }), at)).toBeGreaterThan(convoScore(hit(), at))
    const base = { taken: { urls: new Set<string>(), authors: new Set<string>(), roots: new Set<string>() }, seen: new Set<string>(), own: { bluesky: new Set<string>(), mastodon: new Set<string>() }, at, recentAuthors: new Set(['bluesky:old.bsky.social']), blocked: new Set(['bluesky:blocked.bsky.social']), projectName: 'The Wanderer' }
    const list = [
      hit(),
      hit({ key: 'k2', root: 'k2', author: 'old.bsky.social', url: 'u2' }),
      hit({ key: 'k3', root: 'k3', author: 'blocked.bsky.social', url: 'u3' }),
      hit({ key: 'k4', root: 'k4', author: 'full.bsky.social', url: 'u4', stats: { followers: 1, likes: 1, replies: 500, reposts: 0, views: null } }),
      hit({ key: 'k5', root: 'k5', author: 'stale.bsky.social', url: 'u5', at: hoursAgo(50) }),
    ]
    expect(convoFilter(list, base).map(h => h.key)).toEqual(['k1'])
    expect(convoFilter([hit({ lang: 'ko' })], { ...base, languages: ['en', 'de'] })).toEqual([])
  })

  it('X über Brave, YouTube über RSS, Handles und Vorbilder', () => {
    expect(braveConvoHit('x', { url: 'https://twitter.com/retrowave_fm/status/123', title: 'retrowave_fm on X: "hi"', snippet: 'hi there', age: null, publishedAt: hoursAgo(1) })).toMatchObject({ platform: 'x', url: 'https://x.com/retrowave_fm/status/123', author: 'retrowave_fm' })
    expect(braveConvoHit('x', { url: 'https://x.com/i/status/1', title: '', snippet: '', age: null, publishedAt: null })).toBeNull()
    const yt = parseYtFeed(YT_FEED, 'synthchannel')
    expect(yt[0]).toMatchObject({ url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Making a darksynth track from scratch', stats: { views: 52000, likes: 900 } })
    expect(cleanHandle('mastodon', '@Joe@Fosstodon.org')).toBe('joe@fosstodon.org')
    expect(cleanHandle('bluesky', 'https://bsky.app/profile/Ana.bsky.social')).toBe('ana.bsky.social')
    expect(cleanHandle('x', '@too_long_handle_for_x_123')).toBeNull()
    const merged = mergeVoices([{ platform: 'x', handle: 'keep', pinned: true, source: 'ki' }, { platform: 'x', handle: 'gone', source: 'ki' }, { platform: 'x', handle: 'no', blocked: true, source: 'ki' }], [{ platform: 'x', handle: 'new', followers: 5, source: 'ki' }, { platform: 'x', handle: 'NO', source: 'ki' }])
    expect(merged.map(v => v.handle)).toEqual(['keep', 'no', 'new'])
  })
})

describe('Ablauf', () => {
  it('Plattformen: ausdrücklich gesetzt gilt, sonst nur mit Konto oder Strategie-Kanal', async () => {
    project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
    expect(await convoEffective(db, ws, project)).toEqual({ bluesky: true, mastodon: false, x: true, threads: false, tiktok: false, youtube: true })
    expect(await convoEffective(db, ws, { ...project, setup: { ...project.setup, listening: {} } })).toMatchObject({ bluesky: true, x: false, youtube: false })
  })

  it('findet Vorbild-Beiträge, schreibt 3 Fassungen, siebt per Bannliste und Ton-Prüfung', async () => {
    const out = await runListening(db, ws, { fetch: web, llmFetch: llm })
    expect(out.status).toBe('ok')
    const tasks = await convoTasks()
    const by = Object.fromEntries(tasks.map(t => [parseListenOrigin(t.origin)!.platform, t]))
    expect(Object.keys(by).sort()).toEqual(['bluesky', 'x', 'youtube'])
    const b = by.bluesky!
    expect(b.status).toBe('entwurf_fertig')
    expect(b.category).toBe('community')
    expect(b.targetUrl).toBe('https://bsky.app/profile/did:plc:synthqueen/post/v1')
    expect(b.description).toMatch(/^Beitrag zum Mitreden von @synthqueen\.bsky\.social/)
    expect(b.description).toContain('Reichweite: 25.000 Follower')
    expect(b.description).toContain('antwortet Aimarage selbst über @own.bsky.social')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, b.id))
    expect(d!.body).toBe('Juno bass on darksynth just hits different')
    expect(d!.variants).toEqual({ 'alt-2': 'oh the Juno bass, that sound never gets old' })
    const src = parseListenDesc(b.description)!
    expect(src).toMatchObject({ relation: 'conversation', author: 'synthqueen.bsky.social', url: b.targetUrl })
    const write = prompts.find(p => p.includes('Schreibe drei verschiedene kurze Kommentare') && p.includes('Juno'))!
    expect(write).toContain('So klingen die anderen Kommentare dort')
    expect(write).toContain('Juno forever')
    expect(write).toContain('pass auf, dass niemand deinen Server hackt')
    const y = by.youtube!
    expect(y.humanStep).toBe('Selbst kommentieren')
    expect(y.description).toContain('Aimarage kommentiert dort nie selbst')
    expect(replyAccount(ws, project, y)).toBeNull()
    expect(whereFor(ws, y, project, [])).toMatchObject({ by: 'human' })
    expect(by.x!.targetUrl).toBe('https://x.com/retrowave_fm/status/123456')
    expect(calls.filter(u => u.includes('q=site%3Ax.com'))).toHaveLength(2)
  })

  it('zweiter Lauf: nichts doppelt, keine zweite Brave-Suche am selben Tag', async () => {
    const before = (await convoTasks()).length
    const n = calls.filter(u => u.includes('q=site%3Ax.com')).length
    await runListening(db, ws, { fetch: web, llmFetch: llm })
    expect((await convoTasks()).length).toBe(before)
    expect(calls.filter(u => u.includes('q=site%3Ax.com')).length).toBe(n)
  })

  it('YouTube: Freigabe postet nie, Verwerfen und Wahl werden zur Lehre', async () => {
    const y = (await convoTasks()).find(t => parseListenOrigin(t.origin)!.platform === 'youtube')!
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, y.id))
    await applyDraftAction(db, ws, userId, d!.id, 'approve')
    expect((await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'listening_reply')))).toHaveLength(0)
    const b = (await convoTasks()).find(t => parseListenOrigin(t.origin)!.platform === 'bluesky')!
    const [bd] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, b.id))
    await applyDraftAction(db, ws, userId, bd!.id, 'reject', { reason: 'zu glatt' })
    await rememberTone(db, project.id, { picked: { chosen: 'oh the Juno bass', others: ['Great point'] } })
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id))
    expect(p!.setup.listening?.tone?.rejected?.[0]).toMatchObject({ text: 'Juno bass on darksynth just hits different', reason: 'zu glatt' })
    expect(p!.setup.listening?.tone?.picked?.[0]).toMatchObject({ chosen: 'oh the Juno bass' })
    expect(p!.setup.listening?.voices?.list.length).toBe(3)
  })
})
