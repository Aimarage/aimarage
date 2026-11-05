import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runDraftTask } from '../../server/lib/agent'
import { BRAVE_USD_PER_1000, braveUsage, installBraveMeter, recordBrave } from '../../server/lib/brave-usage'
import { sealAppSecret, updateSettings } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { braveSearch, forumHost, parseBrave, redditQuery, redditThreadOf, redditThreads, resetBraveState, setBraveRecorder, siteQuery } from '../../server/lib/platforms/brave'
import { braveThreads, threadFresh, threadSearch } from '../../server/lib/reddit'
import { resetSecretCache } from '../../server/lib/secret'
import { parseRedditNote } from '../../shared/utils/reddit'

const json = (d: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...headers } })

function mockFetch(handler: (url: string) => Response) {
  const calls: { url: string, headers: Record<string, string> }[] = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> })
    return handler(url)
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

const NOW = Date.now()
const DAY = 86_400_000
const pageAge = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 19)
const PAGE_AGE = pageAge(2)
const hit = (url: string, title: string, o: Record<string, unknown> = {}) => ({ url, title, description: `About <strong>${title}</strong> &amp; more`, age: '2 days ago', page_age: PAGE_AGE, ...o })
const results = {
  web: {
    results: [
      hit('https://www.reddit.com/r/audiophile/comments/abc123/flac_vs_streaming/', 'FLAC vs streaming? : r/audiophile'),
      hit('https://www.reddit.com/r/audiophile/', 'r/audiophile'),
      hit('https://old.reddit.com/r/audiophile/comments/ABC123/flac_vs_streaming/', 'Duplicate'),
      hit('https://www.reddit.com/r/headphones/comments/zz9/flac/', 'Other sub'),
      hit('https://example.com/flac', 'Blog'),
      { url: 'http://insecure.example/x', title: 'x' },
    ],
  },
}

beforeEach(() => resetBraveState())

describe('Brave-Suche', () => {
  it('baut Suchanfragen mit site:', () => {
    expect(redditQuery('audiophile', ['FLAC', 'Streaming'])).toBe('site:reddit.com r/audiophile FLAC Streaming')
    expect(redditQuery(null, 'FLAC')).toBe('site:reddit.com FLAC')
    expect(siteQuery('forum.hifi.de', [])).toBe('site:forum.hifi.de')
  })

  it('filtert auf Reddit-Threads, je Sub und ohne Doppelte', () => {
    const list = parseBrave(results)
    expect(list).toHaveLength(5)
    expect(list[0]).toEqual({ title: 'FLAC vs streaming? : r/audiophile', url: 'https://www.reddit.com/r/audiophile/comments/abc123/flac_vs_streaming/', snippet: 'About FLAC vs streaming? : r/audiophile & more', age: '2 days ago', publishedAt: new Date(PAGE_AGE).toISOString() })
    expect(redditThreads(list, 'audiophile').map(r => r.title)).toEqual(['FLAC vs streaming? : r/audiophile'])
    expect(redditThreads(list).map(r => redditThreadOf(r.url)?.sub)).toEqual(['audiophile', 'headphones'])
    expect(parseBrave({})).toEqual([])
  })

  it('schickt Schlüssel im Header, Frische letzter Monat, wartet zwischen Anfragen', async () => {
    const m = mockFetch(() => json(results))
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
    }
    await braveSearch('brave-key-123', 'site:reddit.com FLAC', m.fn, { sleep })
    await braveSearch('brave-key-123', 'site:reddit.com FLAC', m.fn, { sleep })
    const u = new URL(m.calls[0]!.url)
    expect(u.origin + u.pathname).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: 'site:reddit.com FLAC', count: '10', freshness: 'pm' })
    expect(m.calls[0]!.headers).toMatchObject({ 'X-Subscription-Token': 'brave-key-123', 'Accept': 'application/json' })
    expect(waits).toHaveLength(1)
  })

  it('Fehler: Schlüssel abgelehnt, Limit kurz abwarten, sonst abbrechen', async () => {
    const sleep = async () => {}
    await expect(braveSearch('k', 'q', mockFetch(() => json({}, 401)).fn, { sleep })).rejects.toThrow('API-Schlüssel abgelehnt')
    let n = 0
    const retry = mockFetch(() => (++n === 1 ? json({}, 429, { 'x-ratelimit-reset': '1, 99999' }) : json(results)))
    expect(await braveSearch('k', 'q', retry.fn, { sleep })).toHaveLength(5)
    await expect(braveSearch('k', 'q', mockFetch(() => json({}, 429, { 'x-ratelimit-reset': '1, 99999' })).fn, { sleep })).rejects.toThrow('Anfrage-Limit')
    await expect(braveSearch('k', 'q', mockFetch(() => json({}, 429, { 'x-ratelimit-reset': '3600' })).fn, { sleep })).rejects.toThrow('Anfrage-Limit')
    const err = await braveSearch('secret-key', 'q', mockFetch(() => json({ error: { detail: 'bad' } }, 422)).fn, { sleep }).catch(e => (e as Error).message)
    expect(err).not.toContain('secret-key')
  })

  it('Threads aus Brave: Titel ohne Sub-Endung, Link normalisiert', async () => {
    const m = mockFetch(() => json(results))
    const out = await braveThreads('k', ['audiophile'], ['FLAC'], m.fn, 5, async () => {})
    expect(out).toEqual([expect.objectContaining({ id: 'abc123', sub: 'audiophile', title: 'FLAC vs streaming?', url: 'https://www.reddit.com/r/audiophile/comments/abc123/flac_vs_streaming/', via: 'brave', age: '2 days ago' })])
  })

  it('nichts im eigenen Sub: erst Communities, nur letzte 7 Tage, ältere und undatierte Threads fallen weg', async () => {
    const m = mockFetch(url => json(new URL(url).searchParams.get('q')!.includes('r/audiophile') ? results : { web: { results: [] } }))
    const out = await braveThreads('k', ['lossless'], ['FLAC'], m.fn, 5, async () => {}, ['audiophile'], NOW)
    expect(m.calls.map(c => [new URL(c.url).searchParams.get('q'), new URL(c.url).searchParams.get('freshness')])).toEqual([
      ['site:reddit.com r/lossless FLAC', 'pw'],
      ['site:reddit.com r/audiophile FLAC', 'pw'],
    ])
    expect(out.map(t => t.sub)).toEqual(['audiophile'])
    const old = mockFetch(() => json({ web: { results: [
      { url: 'https://www.reddit.com/r/lossless/comments/old1/x/', title: 'Alt', description: '', page_age: pageAge(14) },
      { url: 'https://www.reddit.com/r/lossless/comments/nodate/x/', title: 'Ohne Datum', description: '' },
    ] } }))
    expect(await braveThreads('k', ['lossless'], ['FLAC'], old.fn, 5, async () => {}, [], NOW)).toEqual([])
    expect(old.calls).toHaveLength(1)
  })

  it('Thread-Alter: Datum, relative Angabe, ohne Datum nicht frisch', () => {
    const now = Date.parse('2026-10-09T08:00:00Z')
    expect(threadFresh({ age: '2 days ago' }, now)).toBe(true)
    expect(threadFresh({ age: 'vor 3 Tagen' }, now)).toBe(true)
    expect(threadFresh({ age: '2 weeks ago' }, now)).toBe(false)
    expect(threadFresh({ createdAt: '2026-10-01T07:00:00Z' }, now)).toBe(false)
    expect(threadFresh({ createdAt: '2026-10-05T07:00:00Z' }, now)).toBe(true)
    expect(threadFresh({ createdAt: '', age: null }, now)).toBe(false)
    expect(threadFresh({ age: 'October 7, 2026' }, now)).toBe(true)
  })

  it('Forum-Domain aus Ziel oder Kanal', () => {
    expect(forumHost({ targetUrl: 'https://www.hifi-forum.de/' })).toBe('hifi-forum.de')
    expect(forumHost({ targetUrl: 'https://www.hifi-forum.de/viewthread-1-2.html?x=1' })).toBeNull()
    expect(forumHost({ channel: 'Forum head-fi.org' })).toBe('head-fi.org')
    expect(forumHost({ channel: 'Reddit' })).toBeNull()
  })
})

describe('Brave im Agenten', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect

  beforeAll(async () => {
    process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
    process.env.APP_SECRET = 'test-secret'
    resetSecretCache()
    ;({ db, close } = await openTestDb())
    const [w] = await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning()
    const [p] = await db.insert(schema.projects).values({ workspaceId: w!.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'music', url: 'https://tonebase.com' }).returning()
    project = p!
    await updateSettings(db, w!.id, s => ({ ...s, apps: { brave: { clientId: '', secret: sealAppSecret(w!.id, 'brave', 'brave-key-123') } } }))
    ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w!.id)))[0]!
  })
  afterAll(async () => {
    delete process.env.MA_NOW
    delete process.env.APP_SECRET
    resetSecretCache()
    await close()
  })

  it('ohne Reddit-App, mit Brave: sucht den Thread und schreibt darauf', async () => {
    expect(threadSearch(ws)).toBe(true)
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'BR-1', title: 'Antwort: FLAC vs. Streaming', category: 'community', channel: 'Reddit r/audiophile', status: 'geplant', dueDate: '2026-10-14', draftKind: 'post', language: 'en' }).returning()
    const web = mockFetch(() => json(results))
    const prompts: string[] = []
    const llm = async (_url: string, init: RequestInit) => {
      const content = (JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages[1]!.content
      if (!/^(Suchanfrage für Reddit|Relevanz-Check|Subreddit-Regeln)/.test(content)) prompts.push(content)
      const reply = content.startsWith('Prüfe diesen Marketing-Entwurf') ? '{"problems": []}' : content.startsWith('Suchanfrage für Reddit') ? '{"query": "FLAC Streaming"}' : content.startsWith('Relevanz-Check') ? '{"threads": [{"i": 0, "problem": "Will wissen, ob FLAC hörbar besser ist als Streaming", "solves": true, "how": "Lossless-Wissen"}], "index": 0}' : JSON.stringify({ kind: 'post', targetUrl: 'https://www.reddit.com/r/audiophile/comments/abc123/flac_vs_streaming/', body: 'FLAC keeps every bit. I run tonebase, a lossless store.' })
      return json({ model: 'mock', choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }
    await runDraftTask(db, ws, task!.id, llm as unknown as typeof fetch, { webFetch: web.fn })
    const search = web.calls.filter(c => !/about|rules/.test(decodeURIComponent(c.url)))
    expect(search).toHaveLength(1)
    expect(new URL(search[0]!.url).searchParams.get('q')).toBe('site:reddit.com r/audiophile FLAC Streaming')
    expect(prompts[0]).toContain('über die Brave-Suche gefunden')
    expect(prompts[0]).toContain('FLAC vs streaming?')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task!.id)).orderBy(desc(schema.drafts.version))
    expect(d!.targetUrl).toBe('https://www.reddit.com/r/audiophile/comments/abc123/flac_vs_streaming/')
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task!.id))).map(n => parseRedditNote(n.text)).filter(Boolean)
    expect(notes[0]).toMatchObject({ kind: 'thread', title: 'FLAC vs streaming?' })
  })

  it('Thread schon von anderer offener Aufgabe belegt oder Relevanz-Check sagt null: kein Entwurf', async () => {
    const mk = async (code: string) => (await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code, title: 'Antwort: FLAC vs. Streaming', category: 'community', channel: 'r/audiophile', status: 'geplant', dueDate: '2026-10-14', draftKind: 'post', language: 'en' }).returning())[0]!
    const llm = (index: number | null) => (async (_url: string, init: RequestInit) => {
      const content = (JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages[1]!.content
      if (!/^(Suchanfrage|Relevanz)/.test(content)) throw new Error('kein Entwurf erwartet')
      return json({ model: 'mock', choices: [{ message: { content: content.startsWith('Suchanfrage') ? '{"query": "FLAC streaming"}' : JSON.stringify({ index }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }) as unknown as typeof fetch
    const taken = await mk('BR-3')
    expect((await runDraftTask(db, ws, taken.id, llm(0), { webFetch: mockFetch(() => json(results)).fn })).summary).toContain('Kein aktueller Thread')
    const other = { web: { results: [hit('https://www.reddit.com/r/audiophile/comments/zz7/speakers/', 'Speakers in the new car')] } }
    const none = await mk('BR-4')
    expect((await runDraftTask(db, ws, none.id, llm(null), { webFetch: mockFetch(() => json(other)).fn })).summary).toContain('Kein aktueller Thread')
    expect(await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, none.id))).toHaveLength(0)
  })

  it('kein frischer Thread: kein Entwurf, Notiz und neuer Versuch in ein paar Tagen', async () => {
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'BR-2', title: 'Antwort: FLAC vs. Streaming', category: 'community', channel: 'r/lossless', status: 'entwurf_fertig', dueDate: '2026-10-14', draftKind: 'post', language: 'en' }).returning()
    await db.insert(schema.drafts).values({ taskId: task!.id, version: 1, kind: 'post', body: 'Vorlage', byAgent: true, status: 'offen' })
    const web = mockFetch(() => json({ web: { results: [] } }))
    const llm = mockFetch(() => {
      throw new Error('kein LLM-Aufruf erwartet')
    })
    const out = await runDraftTask(db, ws, task!.id, llm.fn, { webFetch: web.fn })
    expect(out.status).toBe('skipped')
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task!.id))
    expect(t!.status).toBe('geplant')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task!.id))
    expect(d!.status).toBe('ersetzt')
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task!.id))).map(n => n.text)
    expect(notes).toEqual(['Gerade kein passender aktueller Thread, der Agent sucht in 3 Tagen nochmal.'])
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))
    expect(jobs.some(j => (j.payload as { taskId?: string }).taskId === task!.id && j.runAt.getTime() > Date.parse('2026-10-15T00:00:00Z'))).toBe(true)
  })
})

describe('Brave-Zähler', () => {
  let db: Db
  let close: () => Promise<void>
  let wsId: string

  beforeAll(async () => {
    ;({ db, close } = await openTestDb())
    const [w] = await db.insert(schema.workspaces).values({ name: 'Zähler' }).returning()
    wsId = w!.id
    installBraveMeter(db)
  })
  afterAll(async () => {
    setBraveRecorder(null)
    await close()
  })

  it('zählt jeden Request je Tag, Zweck und Projekt, auch Retries; ohne Zweck nicht', async () => {
    const sleep = async () => {}
    const use = { ws: wsId, project: 'p1', purpose: 'listening' as const }
    await braveSearch('k', 'q', mockFetch(() => json(results)).fn, { sleep, use })
    let n = 0
    await braveSearch('k', 'q', mockFetch(() => (++n === 1 ? json({}, 429, { 'x-ratelimit-reset': '1' }) : json(results))).fn, { sleep, use })
    await braveSearch('k', 'q', mockFetch(() => json(results)).fn, { sleep, use: { ws: wsId, purpose: 'geo' } })
    await expect(braveSearch('k', 'q', mockFetch(() => json({}, 401)).fn, { sleep, use: { ws: wsId, purpose: 'geo' } })).rejects.toThrow()
    await braveSearch('k', 'q', mockFetch(() => json(results)).fn, { sleep })
    const rows = await db.select().from(schema.braveUsage).where(eq(schema.braveUsage.workspaceId, wsId))
    expect(rows.map(r => [r.purpose, r.projectId, r.calls]).sort()).toEqual([['geo', '', 2], ['listening', 'p1', 3]])
  })

  it('Übersicht: heute, Monat, 30 Tage je Zweck, Kosten', async () => {
    const at = new Date('2026-10-24T10:00:00Z')
    await db.delete(schema.braveUsage)
    await db.insert(schema.braveUsage).values([
      { workspaceId: wsId, day: '2026-10-24', purpose: 'reddit', calls: 100 },
      { workspaceId: wsId, day: '2026-10-02', purpose: 'geo', calls: 50, projectId: 'x' },
      { workspaceId: wsId, day: '2026-09-28', purpose: 'reddit', calls: 250 },
      { workspaceId: wsId, day: '2026-08-01', purpose: 'reddit', calls: 999 },
    ])
    await recordBrave(db, { ws: wsId, purpose: 'reddit' }, at)
    const u = await braveUsage(db, wsId, at)
    expect(u).toMatchObject({ today: 101, month: 151, last30: 401, usdMonth: 0.76, usdLast30: 2.01, usdPer1000: BRAVE_USD_PER_1000 })
    expect(u.byPurpose).toEqual([{ purpose: 'reddit', calls: 351 }, { purpose: 'geo', calls: 50 }])
  })
})
