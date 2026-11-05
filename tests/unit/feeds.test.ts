import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDraftTask } from '../../server/lib/agent'
import { upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { resetSecretCache } from '../../server/lib/secret'
import { routeOf } from '../../server/services/views'
import { addFeed, feedLinkInHtml, normLink, parseFeed, removeFeed, sitemapEntries, syncProjectFeeds } from '../../server/lib/feeds'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect

const RSS = (items: { title: string, link: string, date: string }[]) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog | Test</title><language>en</language>
${items.map(i => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><guid isPermaLink="true">${i.link}</guid><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>Über &amp; ${i.title}</description></item>`).join('\n')}
</channel></rss>`

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en"><title>Blog | Linkbox</title>
<entry><title>Raindrop Alternative</title><link rel="alternate" type="text/html" href="https://www.linkbox.net/blog/raindrop"/><id>tag:linkbox,raindrop</id><published>2026-10-08T22:00:00Z</published><summary>EU hosted &lt;b&gt;bookmarks&lt;/b&gt;</summary></entry>
</feed>`

const SITEMAP = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://chatsite.site/de/ratgeber</loc></url>
<url><loc>https://chatsite.site/de/ratgeber/chatbase-alternative-eu</loc><lastmod>2026-10-09</lastmod></url>
<url><loc>https://chatsite.site/guides/chatbase-alternative-eu</loc><lastmod>2026-10-09</lastmod></url>
</urlset>`

function fakeFetch(routes: Record<string, string>) {
  const calls: string[] = []
  const f = async (url: string) => {
    calls.push(url)
    const body = routes[url]
    if (body === undefined) return new Response('nope', { status: 404 })
    return new Response(body, { status: 200, headers: { 'Content-Type': body.startsWith('<?xml') ? 'application/xml' : 'text/html' } })
  }
  return { f, calls }
}

async function reload() {
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-10T09:00:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { agentEnabled: false } }).returning())[0]!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'The Wanderer', code: 'TVS', icon: 'T', url: 'https://thewandererai.com', languages: ['en'], setup: { blog: 'https://thewandererai.com/blog' } }).returning())[0]!
  await db.insert(schema.strategies).values({ workspaceId: ws.id, projectId: project.id, status: 'aktiv', channels: [
    { key: 'content-blog', name: 'Content & Blog', category: 'content', why: '', goalIds: [], weight: 3, days: ['MO'], time: '10:00', active: true },
    { key: 'social-media', name: 'Social Media', category: 'social', why: '', goalIds: [], weight: 5, days: ['MO', 'WE', 'FR'], time: '11:00', active: true },
  ] })
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Feeds lesen', () => {
  it('RSS mit CDATA, Entities, Datum und Sprache', () => {
    const p = parseFeed(RSS([{ title: 'Superposition', link: 'https://thewandererai.com/blog/superposition', date: '2026-10-09T00:00:00+02:00' }]), 'https://thewandererai.com/blog/rss.xml')!
    expect(p.kind).toBe('rss')
    expect(p.title).toBe('Blog | Test')
    expect(p.language).toBe('en')
    expect(p.entries[0]).toMatchObject({ title: 'Superposition', link: 'https://thewandererai.com/blog/superposition', summary: 'Über & Superposition', publishedAt: '2026-10-08T22:00:00.000Z' })
  })

  it('Atom mit alternate-Link und HTML im Auszug', () => {
    const p = parseFeed(ATOM, 'https://www.linkbox.net/blog/feed.xml')!
    expect(p.kind).toBe('atom')
    expect(p.language).toBe('en')
    expect(p.entries[0]).toMatchObject({ guid: 'tag:linkbox,raindrop', link: 'https://www.linkbox.net/blog/raindrop', summary: 'EU hosted bookmarks' })
  })

  it('Sitemap: nur Unterseiten des Blog-Pfads mit Datum', () => {
    const p = parseFeed(SITEMAP, 'https://chatsite.site/sitemap.xml')!
    expect(p.kind).toBe('sitemap')
    expect(sitemapEntries(p.entries, 'https://chatsite.site/de/ratgeber').map(e => e.link)).toEqual(['https://chatsite.site/de/ratgeber/chatbase-alternative-eu'])
    expect(sitemapEntries(p.entries, null)).toHaveLength(2)
  })

  it('Feed-Link im HTML finden, Links normalisieren', () => {
    expect(feedLinkInHtml('<link rel="alternate" type="application/rss+xml" title="x" href="/blog/en/rss.xml">', 'https://tonebase.com/blog')).toBe('https://tonebase.com/blog/en/rss.xml')
    expect(normLink('https://WWW.Example.com/a/?utm_source=x#top')).toBe('https://example.com/a')
    expect(parseFeed('<html><body>hi</body></html>', 'https://x.example')).toBeNull()
  })
})

describe('Feed-Abgleich', () => {
  const FEED = 'https://thewandererai.com/blog/rss.xml'
  const items = [
    { title: 'Superposition: The New Album', link: 'https://thewandererai.com/blog/superposition', date: '2026-10-09T00:00:00+02:00' },
    { title: 'Old Story', link: 'https://thewandererai.com/blog/old', date: '2026-09-01T00:00:00+02:00' },
  ]

  it('Blog-Adresse wird zum Feed, beim ersten Abruf nur die letzten 7 Tage', async () => {
    const { f } = fakeFetch({ 'https://thewandererai.com/blog': '<html><head><link rel="alternate" type="application/rss+xml" href="https://thewandererai.com/blog/rss.xml"></head></html>', [FEED]: RSS(items) })
    const added = await addFeed(db, project, { url: 'thewandererai.com/blog' }, f)
    expect(added.feed.url).toBe(FEED)
    expect(added.entries).toBe(2)
    await expect(addFeed(db, project, { url: FEED }, f)).rejects.toThrow('schon eingetragen')
    await reload()
    const r = await syncProjectFeeds(db, ws, project, { fetchImpl: f, draft: false })
    expect(r.created).toBe(1)
    expect(r.skipped).toBe(1)
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id))
    expect(t).toMatchObject({ category: 'social', draftKind: 'post', targetUrl: 'https://thewandererai.com/blog/superposition', channel: 'Social Media', strategyChannel: 'social-media', dueDate: '2026-10-10', dueTime: '11:00', origin: 'rss', language: 'en' })
    expect(t!.description).toContain('Superposition')
    const seen = await db.select().from(schema.feedItems).where(eq(schema.feedItems.projectId, project.id))
    expect(seen.map(s => s.status).sort()).toEqual(['alt', 'aufgabe'])
    await reload()
    expect(project.setup.feeds![0]!.syncedAt).toBeTruthy()
  })

  it('zweiter Abruf: keine Doppelten, neue Einträge auch ohne Feed-Duplikat', async () => {
    const more = [...items, { title: 'Tour Dates', link: 'https://thewandererai.com/blog/tour?utm_source=rss', date: '2026-10-10T07:00:00+02:00' }]
    const { f } = fakeFetch({ [FEED]: RSS(more) })
    await reload()
    const r = await syncProjectFeeds(db, ws, project, { fetchImpl: f, draft: false })
    expect(r.created).toBe(1)
    const again = await syncProjectFeeds(db, ws, project, { fetchImpl: f, draft: false })
    expect(again.created).toBe(0)
    expect(again.skipped).toBe(0)
    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id))
    expect(tasks).toHaveLength(2)
  })

  it('selbst veröffentlichter Artikel: nur ohne vorhandenen Social-Post', async () => {
    const mk = async (code: string, category: 'content' | 'social', url: string, targetUrl: string | null = null) => {
      const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code, title: code, category, status: 'erledigt', targetUrl }).returning()
      if (category === 'content') await db.insert(schema.taskLinks).values({ workspaceId: ws.id, projectId: project.id, taskId: t!.id, url })
      return t!
    }
    await mk('TVS-CON-001', 'content', 'https://thewandererai.com/blog/shared')
    await mk('TVS-SOC-090', 'social', '', 'https://thewandererai.com/blog/shared')
    await mk('TVS-CON-002', 'content', 'https://thewandererai.com/blog/unshared')
    const more = [
      { title: 'Shared', link: 'https://thewandererai.com/blog/shared', date: '2026-10-10T06:00:00+02:00' },
      { title: 'Unshared', link: 'https://thewandererai.com/blog/unshared/', date: '2026-10-10T06:30:00+02:00' },
    ]
    const { f } = fakeFetch({ [FEED]: RSS(more) })
    await reload()
    const r = await syncProjectFeeds(db, ws, project, { fetchImpl: f, draft: false })
    expect(r.created).toBe(1)
    const [own] = await db.select().from(schema.feedItems).where(and(eq(schema.feedItems.projectId, project.id), eq(schema.feedItems.link, 'https://thewandererai.com/blog/shared')))
    expect(own!.status).toBe('eigen')
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.targetUrl, 'https://thewandererai.com/blog/unshared/'))
    expect(t!.description).toContain('über Aimarage veröffentlicht')
  })

  it('Fehler wird am Feed vermerkt, Entfernen geht', async () => {
    const { f } = fakeFetch({})
    await reload()
    const r = await syncProjectFeeds(db, ws, project, { fetchImpl: f, draft: false })
    expect(r.feeds[0]!.error).toBe('HTTP 404')
    await reload()
    expect(project.setup.feeds![0]!.error).toBe('HTTP 404')
    expect(await removeFeed(db, project.id, FEED)).toBe(true)
    await reload()
    expect(project.setup.feeds).toEqual([])
  })

  it('ohne Social-Kanal und ohne Konten keine Aufgabe', async () => {
    const [p2] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'chatsite', name: 'chatsite', code: 'AMW', icon: 'A', setup: { feeds: [{ url: FEED, addedAt: '2026-10-01T00:00:00Z', syncedAt: '2026-10-09T00:00:00Z' }] } }).returning()
    const { f } = fakeFetch({ [FEED]: RSS([{ title: 'New', link: 'https://thewandererai.com/blog/new', date: '2026-10-10T07:00:00+02:00' }]) })
    const r = await syncProjectFeeds(db, ws, p2!, { fetchImpl: f, draft: false })
    expect(r.created).toBe(0)
    const [item] = await db.select().from(schema.feedItems).where(eq(schema.feedItems.projectId, p2!.id))
    expect(item!.status).toBe('ohne_kanal')
  })
})

describe('RSS-Aufgaben immer in die Freigabe', () => {
  it('auch bei Stufe "macht selbst" mit Konto und Schalter an wird nichts geplant', async () => {
    const [w2] = await db.insert(schema.workspaces).values({ name: 'Live', settings: { llm: { provider: 'ollama', model: 'mock' }, publishLive: true } }).returning()
    const [p] = await db.insert(schema.projects).values({ workspaceId: w2!.id, slug: 'tv', name: 'TV', code: 'TVL', icon: 'T', url: 'https://thewandererai.com', languages: ['en'], autonomy: { social: 'auto' } }).returning()
    const conn = await upsertConnection(db, w2!.id, { provider: 'bluesky', platform: 'bluesky', name: '@tv', handle: 'tv.bsky.social', ext: { did: 'did:plc:tv' } }, { identifier: 'tv.bsky.social', password: 'app-pass' }, { projectId: p!.id })
    await db.update(schema.projects).set({ setup: { social: { accountIds: [conn.id] }, feeds: [{ url: 'https://thewandererai.com/blog/rss.xml', addedAt: '2026-10-01T00:00:00Z', syncedAt: '2026-10-09T00:00:00Z' }] } }).where(eq(schema.projects.id, p!.id))
    const live = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w2!.id)))[0]!
    const proj = (await db.select().from(schema.projects).where(eq(schema.projects.id, p!.id)))[0]!
    const { f } = fakeFetch({ 'https://thewandererai.com/blog/rss.xml': RSS([{ title: 'Live Show', link: 'https://thewandererai.com/blog/live', date: '2026-10-10T07:00:00+02:00' }]) })
    const r = await syncProjectFeeds(db, live, proj, { fetchImpl: f })
    expect(r.created).toBe(1)
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, p!.id))
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))
    expect(job!.payload).toMatchObject({ taskId: t!.id, hold: true })
    expect(routeOf(t!, proj, true)).toBe('approve')
    expect(routeOf({ ...t!, origin: null }, proj, true)).toBe('auto')
    const llm = async () => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify({ kind: 'post', body: 'Live show tonight https://thewandererai.com/blog/live', variants: { bluesky: 'Live show tonight' }, media: 'none' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    await runDraftTask(db, live, t!.id, llm as unknown as typeof fetch)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t!.id))
    expect(d!.status).toBe('offen')
    expect(await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, t!.id))).toHaveLength(0)
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, t!.id))
    expect(notes.map(n => n.text).join(' ')).toContain('Aus dem RSS-Import')
  })
})
