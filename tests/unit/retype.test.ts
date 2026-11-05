import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { runToolDirect, type ChatActor } from '../../server/lib/chat'
import { createTask, updateTask } from '../../server/lib/tasks'
import { articleGate, retypeTitle, samePage, WAITS_FOR_ARTICLE } from '../../server/lib/retype'
import { talkAboutTask } from '../../server/lib/talk'
import { queueDueDrafts } from '../../server/lib/agent'
import { today } from '../../server/lib/clock'
import { addDays } from '../../shared/utils/dates'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let pid: string
let actor: ChatActor
const key = 'social-media'
const d = () => today(ws.timezone)

const page = '<html><head><title>Superposition: The New Album | The Wanderer</title></head><body><h1>Superposition</h1><p>Our new album is out on 10 October.</p></body></html>'
const webFetch = async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })
const answer = (content: string) => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })

const task = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
const byCode = async (code: string) => (await db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, ws.id), eq(schema.tasks.code, code))))[0]!
const draftsOf = async (id: string) => db.select().from(schema.drafts).where(eq(schema.drafts.taskId, id))
const linked = async (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.dependsOnId, id))

beforeAll(async () => {
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  const owner = (await db.insert(schema.users).values({ email: 'owner@retype.local', name: 'Peter' }).returning())[0]!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: owner, role: 'owner' })
  pid = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'The Wanderer', code: 'THE', icon: 'T', url: 'https://thewanderer.band', setup: { blog: 'https://thewanderer.band/blog' } }).returning())[0]!.id
  await db.insert(schema.strategies).values({ workspaceId: ws.id, projectId: pid, status: 'aktiv', channels: [
    { key, name: 'Social Media (Mastodon/Bluesky)', category: 'social', why: 'Reichweite', goalIds: [], weight: 2, base: 0, days: ['TU'], time: '11:00', active: true, places: [], topics: [] },
    { key: 'blog', name: 'Blog', category: 'content', why: 'Suche', goalIds: [], weight: 2, base: 0, days: ['MO'], time: '10:00', active: true, places: [], topics: [] },
  ] })
  actor = { workspace: ws, userId: owner, userName: 'Peter', role: 'owner', access: { all: true, ids: [] } }
})
afterAll(async () => {
  await close()
})

describe('Aufgabe umstellen: Social-Post -> Blog-Artikel', () => {
  it('update_task category content: Artikel mit Blog-Ziel, Text bleibt ohne Plattform-Fassungen, Code bleibt, verweisende Posts entstehen', async () => {
    const t = await createTask(db, { workspaceId: ws.id, projectId: pid, category: 'social', title: 'Superposition vorstellen', channel: 'Social Media (Mastodon/Bluesky)', strategyChannel: key, dueDate: addDays(d(), 3), draftKind: 'post', agentStep: 'Beitrag entwerfen', status: 'entwurf_fertig' })
    await db.insert(schema.drafts).values({ taskId: t.id, version: 1, kind: 'post', body: 'Langer Artikeltext '.repeat(60), platforms: ['x', 'bluesky', 'mastodon'], variants: { x: 'kurz', bluesky: 'kurz' }, byAgent: true })
    const r = await runToolDirect(db, actor, 'update_task', { code: t.code, category: 'content' }) as { code: string, category: string, linkedPosts: string, retyped: { keptDraft: boolean } }
    expect(r.code).toBe(t.code)
    expect(r.category).toBe('content')
    expect(r.retyped.keptDraft).toBe(true)
    const row = await task(t.id)
    expect(row).toMatchObject({ category: 'content', draftKind: 'article', channel: 'Blog', strategyChannel: 'blog', status: 'entwurf_fertig', code: t.code })
    const ds = await draftsOf(t.id)
    const open = ds.find(x => x.status === 'offen')!
    expect(open).toMatchObject({ kind: 'article', version: 2, platforms: [], variants: {} })
    expect(open.body).toContain('Langer Artikeltext')
    expect(ds.find(x => x.version === 1)!.status).toBe('ersetzt')
    const posts = await byCode(r.linkedPosts)
    expect(posts).toMatchObject({ category: 'social', draftKind: 'post', dependsOnId: t.id, strategyChannel: key, channel: 'Social Media (Mastodon/Bluesky)' })
    expect(posts.dueDate! > row.dueDate!).toBe(true)
    const again = await runToolDirect(db, actor, 'update_task', { code: t.code, category: 'content' }).catch(e => e as Error)
    expect(String(again)).toContain('Nichts zu ändern')
    expect(await linked(t.id)).toHaveLength(1)
  })

  it('verweisende Posts warten, bis der Artikel veröffentlicht ist, dann mit Link', async () => {
    const art = await createTask(db, { workspaceId: ws.id, projectId: pid, category: 'content', title: 'Blog-Artikel: Tour', dueDate: d(), draftKind: 'article', agentStep: 'x', status: 'freigegeben' })
    const r = await runToolDirect(db, actor, 'create_task', { project: 'thewanderer', title: 'Posts zur Tour', category: 'social', links_to: art.code, date: d() }) as { code: string, waitsFor: string }
    expect(r.waitsFor).toBe(art.code)
    const post = await byCode(r.code)
    expect((await articleGate(db, post))?.wait).toBe(true)
    await queueDueDrafts(db, ws, d())
    const jobs = async () => (await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))).filter(j => j.payload.taskId === post.id)
    expect(await jobs()).toHaveLength(0)
    await db.insert(schema.taskNotes).values({ taskId: post.id, byAgent: true, text: `${WAITS_FOR_ARTICLE} ${art.code}.` })
    await updateTask(db, await task(art.id), { status: 'erledigt', postedUrl: 'https://thewanderer.band/blog/tour' }, { type: 'agent' })
    const after = await task(post.id)
    expect(after.targetUrl).toBe('https://thewanderer.band/blog/tour')
    expect((await articleGate(db, after))).toMatchObject({ wait: false, url: 'https://thewanderer.band/blog/tour' })
    expect((await jobs()).length).toBeGreaterThan(0)
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, post.id))
    expect(notes.some(n => n.text.startsWith(WAITS_FOR_ARTICLE))).toBe(false)
  })

  it('neuer Blog-Artikel per create_task bekommt automatisch verweisende Posts', async () => {
    const r = await runToolDirect(db, actor, 'create_task', { project: 'thewanderer', title: 'Blog-Artikel: Making of', category: 'content', date: addDays(d(), 5) }) as { code: string, linkedPosts: string }
    const art = await byCode(r.code)
    expect(r.linkedPosts).toBeTruthy()
    expect((await byCode(r.linkedPosts)).dependsOnId).toBe(art.id)
  })
})

describe('draft_from_link auf eigene Seite', () => {
  const url = 'https://thewanderer.band/blog/superposition-the-new-album'

  it('Artikel ausbauen ergibt eine Artikel-Aufgabe, keine Antwort; zweiter Wunsch zur selben Seite wird neue Fassung', async () => {
    const r = await runToolDirect(db, actor, 'draft_from_link', { project: 'thewanderer', url, instructions: 'Bitte den Artikel ausbauen' }, { webFetch }) as { code: string, kind: string, linkedPosts: string }
    expect(r.kind).toBe('article')
    const t = await byCode(r.code)
    expect(t).toMatchObject({ category: 'content', draftKind: 'article', channel: 'Blog', targetUrl: url })
    expect(t.code).toMatch(/^THE-CON-/)
    expect(t.title).toBe('Artikel überarbeiten: Superposition: The New Album | The Wanderer')
    expect((await byCode(r.linkedPosts)).dependsOnId).toBe(t.id)
    const again = await runToolDirect(db, actor, 'draft_from_link', { project: 'thewanderer', url: `${url}/?utm_source=x`, instructions: 'Datum korrigieren: 17. Oktober' }, { webFetch }) as { code: string, existing: boolean }
    expect(again).toMatchObject({ code: t.code, existing: true })
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, t.id))
    expect(notes.some(n => n.text === 'Zum Entwurf: Datum korrigieren: 17. Oktober')).toBe(true)
    expect(await linked(t.id)).toHaveLength(1)
  })

  it('vorhandene Social-Aufgabe zur selben Seite wird zum Artikel umgestellt statt neu angelegt', async () => {
    const u = 'https://thewanderer.band/blog/other'
    const old = await createTask(db, { workspaceId: ws.id, projectId: pid, category: 'social', title: 'Antwort: Other', channel: 'thewanderer.band', dueDate: d(), draftKind: 'post', targetUrl: u, agentStep: 'Antwort entwerfen' })
    const r = await runToolDirect(db, actor, 'draft_from_link', { project: 'thewanderer', url: u, instructions: 'Artikel erweitern' }, { webFetch }) as { code: string, existing: boolean }
    expect(r).toMatchObject({ code: old.code, existing: true })
    expect(await task(old.id)).toMatchObject({ category: 'content', draftKind: 'article' })
  })

  it('fremde Community-Seite bleibt Antwort', async () => {
    const r = await runToolDirect(db, actor, 'draft_from_link', { project: 'thewanderer', url: 'https://www.reddit.com/r/indiemusic/comments/abc/new_album/' }, { webFetch }) as { code: string, kind: string }
    expect(r.kind).toBe('reply')
    expect((await byCode(r.code)).category).toBe('community')
  })

  it('gleiche Seite trotz Protokoll, www und Schrägstrich', () => {
    expect(samePage('https://www.a.de/blog/x/')).toBe(samePage('http://a.de/blog/x?utm=1'))
  })
})

describe('Aufgaben-Chat stellt selbst um', () => {
  it('"Mach einen Blogbeitrag und dazu Social-Posts" -> Artikel plus verweisende Posts', async () => {
    const t = await createTask(db, { workspaceId: ws.id, projectId: pid, category: 'social', title: 'Album-Post', channel: 'Social Media (Mastodon/Bluesky)', strategyChannel: key, dueDate: addDays(d(), 2), draftKind: 'post', agentStep: 'Beitrag entwerfen', status: 'entwurf_fertig' })
    await db.insert(schema.drafts).values({ taskId: t.id, version: 1, kind: 'post', body: 'Kurzer Post', platforms: ['x'], variants: { x: 'Kurzer Post' }, byAgent: true })
    const llmFetch = (async () => answer('{"type": "revise", "text": "Mach ich: Blogartikel, die Posts verweisen darauf.", "convert": "article", "posts": true}')) as unknown as typeof fetch
    const r = await talkAboutTask(db, ws, t, actor.userId, 'Mach einen Blogbeitrag und dazu Social-Posts, die darauf verlinken.', llmFetch)
    expect(r.type).toBe('revise')
    const row = await task(t.id)
    expect(row).toMatchObject({ category: 'content', draftKind: 'article', code: t.code, status: 'geplant' })
    const posts = await linked(t.id)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ category: 'social', strategyChannel: key })
    const jobs = (await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))).filter(j => j.payload.taskId === t.id)
    expect(jobs.length).toBeGreaterThan(0)
  })

  it('Titel passt zur neuen Art: aus "Antwort:" wird ein Artikel, die verweisenden Posts heißen ohne "Antwort:"', async () => {
    expect(retypeTitle('Antwort: Superposition: The New Album | The Wanderer', 'content', true)).toBe('Artikel überarbeiten: Superposition: The New Album | The Wanderer')
    expect(retypeTitle('Post: Superposition', 'content', false)).toBe('Artikel: Superposition')
    expect(retypeTitle('Superposition vorstellen', 'content', false)).toBe('Superposition vorstellen')
    expect(retypeTitle('Artikel überarbeiten: Superposition', 'social', false)).toBe('Post: Superposition')
    const t = await createTask(db, { workspaceId: ws.id, projectId: pid, category: 'social', title: 'Antwort: Superposition: The New Album', channel: 'Social Media (Mastodon/Bluesky)', strategyChannel: key, dueDate: addDays(d(), 3), draftKind: 'post', agentStep: 'Beitrag entwerfen', status: 'entwurf_fertig' })
    await db.insert(schema.drafts).values({ taskId: t.id, version: 1, kind: 'post', body: 'Artikeltext '.repeat(40), platforms: ['x'], variants: {}, byAgent: true })
    const r = await runToolDirect(db, actor, 'update_task', { code: t.code, category: 'content' }) as { linkedPosts: string }
    expect((await task(t.id)).title).toBe('Artikel: Superposition: The New Album')
    expect((await byCode(r.linkedPosts)).title).toBe('Social-Posts zum Artikel: Superposition: The New Album')
  })
})
