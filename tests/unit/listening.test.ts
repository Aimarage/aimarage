import { and, eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { bskyHit, cleanTerms, finishReply, listeningSummary, mastoHit, mastoReply, prefilter, runListening, sendListeningReply, soundsLikeSearch, type ListenHit } from '../../server/lib/listening'
import { resetSecretCache } from '../../server/lib/secret'
import { applyDraftAction } from '../../server/services/drafts'
import { releaseByReviewer } from '../../server/lib/ai-reviewer'
import { releasedDrafts } from '../../server/lib/approval-lists'
import { replyAccount } from '../../server/lib/listen-account'
import { goesOut } from '../../server/lib/mcp-approve'
import { whereFor } from '../../server/lib/where'
import { buildWeeklyReport, renderReportHtml } from '../../server/services/report'
import { listenModeOf, listenOrigin, parseListenOrigin } from '../../shared/utils/listening'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let userId: string

const NOW = Date.parse('2026-10-13T10:00:00+02:00')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function bskyPost(rkey: string, handle: string, text: string, h: number, extra: Record<string, unknown> = {}) {
  return { uri: `at://did:plc:${handle.split('.')[0]}/app.bsky.feed.post/${rkey}`, cid: `cid-${rkey}`, author: { did: `did:plc:${handle.split('.')[0]}`, handle, displayName: handle.split('.')[0] }, record: { text, createdAt: hoursAgo(h), langs: ['en'], ...extra }, indexedAt: hoursAgo(h) }
}

const SEARCH = [
  bskyPost('a1', 'ana.bsky.social', 'Any good bookmark manager recommendations? Pocket is shutting down', 2),
  bskyPost('b1', 'newsbot.bsky.social', 'Looking for a bookmark manager? Read our list', 1),
  bskyPost('c1', 'carl.bsky.social', 'Is there a good bookmarks app for teams?', 80),
  bskyPost('d1', 'bob.bsky.social', 'Looking for an alternative to Raindrop, any ideas?', 5),
  bskyPost('e1', 'eve.bsky.social', 'Anyone know a bookmark tool that works on Linux?', 3),
  bskyPost('f1', 'own.bsky.social', 'Need a bookmark manager? We built one?', 1),
  bskyPost('g1', 'gus.bsky.social', 'Bookmarks are great.', 1),
]

let notifications: unknown[] = []
const posted: { url: string, body: unknown }[] = []

const bsky = async (url: string, init: RequestInit) => {
  if (url.endsWith('createSession')) return json({ accessJwt: 'jwt', did: 'did:plc:own', handle: 'own.bsky.social' })
  if (url.includes('listNotifications')) return json({ notifications })
  if (url.includes('searchPosts')) return json({ posts: SEARCH })
  if (url.includes('getPosts')) return json({ posts: [{ uri: 'at://did:plc:ana/app.bsky.feed.post/a1', cid: 'cid-a1', record: { text: 'q' } }] })
  if (url.endsWith('createRecord')) {
    posted.push({ url, body: JSON.parse(String(init.body)) })
    return json({ uri: 'at://did:plc:own/app.bsky.feed.post/r3', cid: 'x' })
  }
  return json({ error: 'nope' }, 404)
}

const llmCalls: string[] = []
const llm = async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
  const p = body.messages.at(-1)!.content
  llmCalls.push(p.slice(0, 40))
  let reply: unknown = {}
  if (p.includes('Leite Suchbegriffe')) reply = { queries: ['bookmark manager recommendation', 'alternative to Pocket', 'linkbox tips'], tags: ['#Bookmarks', 'pocket'] }
  else if (p.includes('Prüfe jeden Post streng')) {
    const n = (p.match(/^\[\d+\]/gm) ?? []).length
    reply = { items: Array.from({ length: n }, (_, i) => ({ i, ok: true, negative: false, reason: 'sucht einen Bookmark-Manager' })) }
  }
  else if (p.includes('Reaktionen auf eigene Posts')) {
    const n = (p.match(/^\[\d+\]/gm) ?? []).length
    reply = { items: Array.from({ length: n }, (_, i) => ({ i, ok: !p.includes('stop spamming'), negative: p.includes('stop spamming'), reason: 'Frage' })) }
  }
  else if (p.includes('Prüfe jede Fassung streng')) {
    const n = (p.match(/^\[\d+\]/gm) ?? []).length
    reply = { items: Array.from({ length: n }, (_, i) => ({ i, ai: false, lecture: false, real: true, sameLang: true, ok: true, why: 'klingt echt' })), best: 0 }
  }
  else if (p.includes('Schreibe die Antwort')) reply = { text: 'Try linkbox \u2014 I build it, EU hosted: https://linkbox.net/de?x=1 and https://other.example.com', skip: false }
  return json({ model: 'mock', choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })
}

async function reloadProject() {
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}

async function listenTasks() {
  return db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, project.id), like(schema.tasks.origin, 'listening:%'))).orderBy(schema.tasks.createdAt)
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T10:00:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  userId = (await db.insert(schema.users).values({ email: 'p@example.com', name: 'Peter' }).returning())[0]!.id
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'linkbox', name: 'linkbox', code: 'BMX', icon: 'B', url: 'https://linkbox.net', languages: ['en', 'de'], rules: 'Offenlegung als "developer behind linkbox".', setup: { analysis: { competitors: [{ name: 'Raindrop' }] } } }).returning())[0]!
  await upsertConnection(db, ws.id, { provider: 'bluesky', platform: 'bluesky', name: '@own.bsky.social', handle: 'own.bsky.social', ext: { did: 'did:plc:own' } }, { identifier: 'own.bsky.social', password: 'app-pass' }, { projectId: project.id })
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
  await reloadProject()
})

afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Bausteine', () => {
  it('Herkunft codiert Plattform, Art, Autor und Thread', () => {
    const o = listenOrigin({ platform: 'bluesky', kind: 'search', author: 'ana.bsky.social', root: 'at://did:plc:ana/app.bsky.feed.post/a1' })
    expect(parseListenOrigin(o)).toEqual({ platform: 'bluesky', kind: 'search', author: 'ana.bsky.social', root: 'at://did:plc:ana/app.bsky.feed.post/a1' })
    expect(parseListenOrigin('rss')).toBeNull()
    expect(listenModeOf({})).toBe('suggest')
    expect(listenModeOf({ listening: { mode: 'off' } })).toBe('off')
  })

  it('Suchabsicht grob vorab', () => {
    expect(soundsLikeSearch('Kennt jemand einen guten Bookmark-Manager')).toBe(true)
    expect(soundsLikeSearch('any good AI bands')).toBe(true)
    expect(soundsLikeSearch('Wer macht KI-Musik')).toBe(true)
    expect(soundsLikeSearch('Bandcamp banned AI, alternatives')).toBe(true)
    expect(soundsLikeSearch('Our new release is out now')).toBe(false)
  })

  it('Suchbegriffe ohne eigenen Namen, Hashtags ohne #', () => {
    expect(cleanTerms({ queries: ['alternative to Pocket', 'linkbox review', '"looking for" bookmarks', 'x'], tags: ['#Bookmarks', 'ai music'] }, 'linkbox')).toEqual({ queries: ['alternative to Pocket', 'looking for bookmarks'], tags: ['bookmarks', 'aimusic'] })
  })

  it('Bluesky- und Mastodon-Treffer lesen', () => {
    const b = bskyHit(bskyPost('a1', 'ana.bsky.social', 'hi?', 2, { reply: { root: { uri: 'at://root' }, parent: { uri: 'at://parent' } } }), 'search')!
    expect(b).toMatchObject({ url: 'https://bsky.app/profile/did:plc:ana/post/a1', author: 'ana.bsky.social', root: 'at://root', parent: 'at://parent', lang: 'en', bot: false })
    const m = mastoHit({ id: '9', uri: 'https://fosstodon.org/users/joe/statuses/9', url: 'https://fosstodon.org/@joe/9', created_at: hoursAgo(1), language: 'de', content: '<p>Kennt jemand &amp; nutzt einen Bookmark-Manager?</p>', account: { acct: 'joe@fosstodon.org', bot: false } }, 'search', 'https://mastodon.social')!
    expect(m).toMatchObject({ author: 'joe@fosstodon.org', text: 'Kennt jemand & nutzt einen Bookmark-Manager?', lang: 'de' })
    expect(mastoHit({ uri: 'u', content: 'x', account: { acct: 'feed', bot: true } }, 'search', 'https://mastodon.social')!.bot).toBe(true)
  })

  it('Vorauswahl: alt, eigen, Bot, schon beantwortet, keine Frage', () => {
    const hits = SEARCH.map(p => bskyHit(p, 'search')!)
    const own = { bluesky: new Set(['did:plc:own', 'own.bsky.social']), mastodon: new Set<string>() }
    const taken = { urls: new Set<string>(), authors: new Set(['bluesky:eve.bsky.social']), roots: new Set<string>() }
    const out = prefilter(hits, { taken, seen: new Set(), own, at: NOW, competitors: ['Raindrop'], projectName: 'linkbox' })
    expect(out.map(h => h.author)).toEqual(['ana.bsky.social', 'bob.bsky.social'])
  })

  it('Antwort: ein Link mit UTM, normale Bindestriche, Mastodon mit Erwähnung', () => {
    const hit = { platform: 'mastodon', kind: 'search', author: 'joe@fosstodon.org' } as ListenHit
    const t = finishReply('Try linkbox \u2014 https://linkbox.net/x and https://linkbox.net again', hit, { link: 'https://linkbox.net/?utm_campaign=bmx-c1', siteHost: 'linkbox.net', prelim: null })
    expect(t).toBe('@joe@fosstodon.org Try linkbox - https://linkbox.net/?utm_campaign=bmx-c1 and again')
    const r = finishReply('Try linkbox https://linkbox.net', { ...hit, platform: 'reddit' }, { link: 'https://linkbox.net/?u=1', siteHost: 'linkbox.net', prelim: null })
    expect(r).toBe('Try linkbox')
  })
})

describe('Ablauf', () => {
  it('sucht, bewertet und legt höchstens 2 Antworten je Plattform und Tag an', async () => {
    notifications = [{ ...bskyPost('m1', 'fan.bsky.social', 'Does linkbox import from Pocket?', 1, { reply: { root: { uri: 'at://did:plc:own/app.bsky.feed.post/p0' }, parent: { uri: 'at://did:plc:own/app.bsky.feed.post/p0' } } }), reason: 'reply' }]
    const out = await runListening(db, ws, { fetch: bsky, llmFetch: llm })
    expect(out.status).toBe('ok')
    const tasks = await listenTasks()
    const search = tasks.filter(t => parseListenOrigin(t.origin)!.kind === 'search')
    const mention = tasks.filter(t => parseListenOrigin(t.origin)!.kind === 'mention')
    expect(search.map(t => t.targetUrl)).toEqual(['https://bsky.app/profile/did:plc:ana/post/a1', 'https://bsky.app/profile/did:plc:bob/post/d1'].filter(u => search.some(t => t.targetUrl === u)))
    expect(search).toHaveLength(2)
    expect(mention).toHaveLength(1)
    for (const t of tasks) {
      expect(t.status).toBe('entwurf_fertig')
      expect(t.category).toBe('community')
      expect(t.channel).toBe('Bluesky')
    }
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, search[0]!.id))
    expect(d!.body).toContain(`utm_campaign=${search[0]!.code.toLowerCase()}`)
    expect(d!.body).toContain('utm_content=listening')
    expect(d!.body).not.toContain('other.example.com')
    expect(d!.body).not.toMatch(/[\u2013\u2014]/)
    await reloadProject()
    expect(project.setup.listening?.terms?.queries).toEqual(['bookmark manager recommendation', 'alternative to Pocket'])
    expect(project.setup.listening?.notif).toBeTruthy()
  })

  it('zweiter Lauf: nichts doppelt', async () => {
    const before = (await listenTasks()).length
    await runListening(db, ws, { fetch: bsky, llmFetch: llm })
    expect((await listenTasks()).length).toBe(before)
  })

  it('aus: kein Lauf für das Projekt', async () => {
    await db.update(schema.projects).set({ setup: { ...project.setup, listening: { ...project.setup.listening, mode: 'off' } } }).where(eq(schema.projects.id, project.id))
    const out = await runListening(db, ws, { fetch: bsky, llmFetch: llm })
    expect(out.status).toBe('skipped')
    await db.update(schema.projects).set({ setup: { ...project.setup, listening: { ...project.setup.listening, mode: 'suggest' } } }).where(eq(schema.projects.id, project.id))
    await reloadProject()
  })

  it('Bluesky-Antwort geht über das verbundene Konto raus, nicht selbst posten', async () => {
    const [t] = (await listenTasks()).filter(x => x.targetUrl?.endsWith('/a1'))
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t!.id))
    expect(replyAccount(ws, project, t!)).toEqual({ platform: 'bluesky', handle: '@own.bsky.social', connected: true })
    expect(goesOut(ws, project, t!, d!)).toBe(true)
    expect(whereFor(ws, t!, project, [])).toMatchObject({ kind: 'social', mark: 'bluesky', by: 'agent', missing: false })
    expect(replyAccount(ws, { setup: {} }, t!)).toEqual({ platform: 'bluesky', handle: null, connected: false })
    expect(goesOut(ws, { ...project, setup: {} }, t!, d!)).toBe(false)
    expect(replyAccount(ws, project, { origin: listenOrigin({ platform: 'reddit', kind: 'search', author: 'x', root: 'y' }) })).toBeNull()
    const rel = await releaseByReviewer(db, ws, { draftId: d!.id, reason: 'passt', model: 'mock' })
    expect(rel).toEqual({ ok: false, reason: 'Social-Listening-Antworten gibt der Mensch frei' })
  })

  it('Freigeben stößt die Antwort an, ohne "Posten nach außen" nur Trockenlauf', async () => {
    const [t] = (await listenTasks()).filter(x => x.targetUrl?.endsWith('/a1'))
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t!.id))
    await applyDraftAction(db, ws, userId, d!.id, 'approve')
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'listening_reply'))
    expect(jobs.map(j => j.payload)).toEqual([{ taskId: t!.id, draftId: d!.id }])
    const rel = await releasedDrafts(db, ws, eq(schema.tasks.projectId, project.id))
    expect(rel.outgoing.map(r => r.task.id)).toContain(t!.id)
    expect(rel.self.map(r => r.task.id)).not.toContain(t!.id)
    const dry = await sendListeningReply(db, ws, { taskId: t!.id, draftId: d!.id }, bsky)
    expect(dry.summary).toMatch(/Trockenlauf/)
    expect(posted).toHaveLength(0)
  })

  it('antwortet als Reply auf Bluesky und schließt die Aufgabe', async () => {
    ws = (await db.update(schema.workspaces).set({ settings: { ...ws.settings, publishLive: true } }).where(eq(schema.workspaces.id, ws.id)).returning())[0]!
    const [t] = (await listenTasks()).filter(x => x.targetUrl?.endsWith('/a1'))
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t!.id))
    const out = await sendListeningReply(db, ws, { taskId: t!.id, draftId: d!.id }, bsky)
    expect(out.status).toBe('ok')
    const rec = (posted[0]!.body as { record: { reply: unknown, text: string, facets?: unknown[] } }).record
    expect(rec.reply).toEqual({ root: { uri: 'at://did:plc:ana/app.bsky.feed.post/a1', cid: 'cid-a1' }, parent: { uri: 'at://did:plc:ana/app.bsky.feed.post/a1', cid: 'cid-a1' } })
    expect(rec.facets?.length).toBe(1)
    const [done] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, t!.id))
    expect(done!.status).toBe('erledigt')
    expect(done!.postedUrl).toBe('https://bsky.app/profile/own.bsky.social/post/r3')
  })

  it('Verwerfen streicht die Aufgabe', async () => {
    const [t] = (await listenTasks()).filter(x => x.targetUrl?.endsWith('/d1'))
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t!.id))
    await applyDraftAction(db, ws, userId, d!.id, 'reject')
    const [x] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, t!.id))
    expect(x!.status).toBe('verworfen')
  })

  it('negative Reaktion auf eine Antwort pausiert das Projekt', async () => {
    notifications = [{ ...bskyPost('m2', 'grumpy.bsky.social', 'stop spamming your app here', 0.5, { reply: { root: { uri: 'at://did:plc:ana/app.bsky.feed.post/a1' }, parent: { uri: 'at://did:plc:own/app.bsky.feed.post/r3' } } }), reason: 'reply' }]
    await runListening(db, ws, { fetch: bsky, llmFetch: llm })
    await reloadProject()
    expect(Date.parse(project.setup.listening!.pausedUntil!)).toBeGreaterThan(NOW + 6 * 86_400_000)
    expect(project.setup.listening!.pauseReason).toMatch(/grumpy/)
  })

  it('Bericht zählt Antworten und Klicks', async () => {
    const [t] = (await listenTasks()).filter(x => x.status === 'erledigt')
    await db.insert(schema.utmStats).values({ projectId: project.id, day: '2026-10-13', source: 'bluesky', medium: 'community', campaign: t!.code.toLowerCase(), content: 'listening', visits: 4 })
    expect(await listeningSummary(db, project.id, '2026-10-13', '2026-10-13', ws.timezone)).toEqual({ replies: 1, clicks: 4 })
    const r = await buildWeeklyReport(db, ws, project, { days: 7 })
    expect(r.listening).toEqual({ replies: 0, clicks: 0 })
    expect(renderReportHtml({ ...r, listening: { replies: 1, clicks: 4 } })).toContain('Antworten auf Social Listening')
  })
})

describe('Mastodon-Antwort', () => {
  it('löst den Post auf der eigenen Instanz auf und antwortet mit in_reply_to_id', async () => {
    const calls: { url: string, init: RequestInit }[] = []
    const f = async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/api/v2/search')) return json({ statuses: [{ id: '777' }] })
      if (url.endsWith('/api/v1/statuses')) return json({ id: '888', url: 'https://mastodon.social/@me/888' })
      return json({}, 404)
    }
    const url = await mastoReply({ id: 'c', provider: 'mastodon', platform: 'mastodon', name: '@me', url: 'https://mastodon.social', secret: { enc: '', hint: '', setAt: '' } }, { token: 't' }, 'https://fosstodon.org/@joe/9', '@joe@fosstodon.org hi', f, 'draft1')
    expect(url).toBe('https://mastodon.social/@me/888')
    expect(calls[0]!.url).toContain('resolve=true')
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ status: '@joe@fosstodon.org hi', in_reply_to_id: '777', visibility: 'public' })
  })
})
