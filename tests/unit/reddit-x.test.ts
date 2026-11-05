import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parkRedditTasks, resumeRedditTasks, runDraftTask } from '../../server/lib/agent'
import { adapterCtx, finishOAuth, listConnections, sealAppSecret, startOAuth, updateSettings } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { pkceChallenge } from '../../server/lib/platforms/oauth'
import { xAdapter, xToken } from '../../server/lib/platforms/x'
import { keywords, rankThreads, RedditClient, resetRedditState, subredditsOf, userAgent, type RedditThread } from '../../server/lib/reddit'
import { resetSecretCache } from '../../server/lib/secret'
import { parseRedditNote, REDDIT_SETUP, redditSearchUrl, threadNote } from '../../shared/utils/reddit'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let seq = 0

type Call = { url: string, method: string, headers: Record<string, string>, body: string }

const json = (d: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...headers } })

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method ?? 'GET'), headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? '') })
    return handler(url, init)
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

const hour = 3600
const sec = () => Math.floor(Date.now() / 1000)
const post = (id: string, title: string, o: Record<string, unknown> = {}) => ({ kind: 't3', data: { id, subreddit: 'audiophile', title, permalink: `/r/audiophile/comments/${id}/slug/`, author: 'u1', created_utc: sec() - 5 * hour, num_comments: 12, score: 30, selftext: `Body of ${title}`, ...o } })
const listing = (...posts: unknown[]) => ({ kind: 'Listing', data: { children: posts } })

function redditApi(url: string): Response {
  if (url.startsWith('https://www.reddit.com/api/v1/access_token')) return json({ access_token: 'app-token', expires_in: 3600 })
  const u = new URL(url)
  if (u.pathname === '/r/audiophile/search') return json(listing(post('aa1', 'FLAC vs streaming for a home setup?'), post('aa2', 'Is FLAC worth it over Spotify streaming?', { num_comments: 40 })), 200, { 'x-ratelimit-remaining': '98', 'x-ratelimit-reset': '300' })
  if (u.pathname === '/r/audiophile/new') return json(listing(post('aa3', 'Old FLAC thread', { created_utc: sec() - 10 * 86400 }), post('aa4', 'Locked FLAC streaming thread', { locked: true }), post('aa5', 'Best cables?')))
  if (u.pathname.startsWith('/comments/')) {
    const id = u.pathname.split('/')[2]!
    const title = id === 'aa2' ? 'Is FLAC worth it over Spotify streaming?' : 'FLAC vs streaming for a home setup?'
    return json([listing(post(id, title, id === 'aa2' ? { num_comments: 40 } : {})), listing({ kind: 't1', data: { author: 'c1', score: 50, body: 'Depends on your DAC.' } }, { kind: 't1', data: { author: 'c2', score: 3, body: '[removed]' } })])
  }
  if (u.pathname === '/r/audiophile/about/rules') return json({ rules: [{ short_name: 'No self-promotion', description: 'Max 10% of your posts may link your own stuff.' }, { short_name: 'Be civil', description: '' }] })
  return json({ message: 'Not Found' }, 404)
}

function llmMock(draft: Record<string, unknown>) {
  const prompts: string[] = []
  const fn = async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as { messages: { content: string }[] }
    const content = b.messages[1]!.content
    if (!/^(Suchanfrage für Reddit|Relevanz-Check|Subreddit-Regeln)/.test(content)) prompts.push(content)
    const reply = content.startsWith('Prüfe diesen Marketing-Entwurf') ? '{"problems": []}' : content.startsWith('Suchanfrage für Reddit') ? '{"query": "FLAC Streaming"}' : content.startsWith('Relevanz-Check') ? '{"threads": [{"i": 0, "problem": "Will wissen, ob FLAC hörbar besser ist als Streaming", "solves": true, "how": "Lossless-Wissen"}], "index": 0}' : JSON.stringify(draft)
    return json({ model: 'mock', choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  }
  return { fn: fn as unknown as typeof fetch, prompts }
}

async function mkTask(v: Partial<typeof schema.tasks.$inferInsert>) {
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `RX-${++seq}`, title: 'Antwort: FLAC vs. Streaming', category: 'community', channel: 'Reddit r/audiophile', status: 'geplant', dueDate: '2026-10-14', draftKind: 'post', language: 'en', ...v }).returning()
  return t!
}

async function reloadWs() {
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  const [w] = await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning()
  ws = w!
  const [p] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'music', url: 'https://tonebase.com' }).returning()
  project = p!
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})
beforeEach(() => resetRedditState())

describe('Reddit nur lesen', () => {
  it('Suchbegriffe, Subreddits, Notizen', () => {
    expect(keywords('Antwort: FLAC vs. Streaming')).toEqual(['FLAC', 'Streaming'])
    expect(subredditsOf({ title: 'Antwort: FLAC', channel: 'Reddit r/lossless, r/audiophile' })).toEqual(['lossless', 'audiophile'])
    expect(subredditsOf({ title: 'Antwort: FLAC', channel: 'Reddit' }, ['r/audiophile', 'Head-Fi'])).toEqual(['audiophile'])
    expect(userAgent('u/peter')).toBe('aimarage/1.0 by peter')
    const url = redditSearchUrl('audiophile', 'FLAC Streaming')
    expect(url).toBe('https://www.reddit.com/r/audiophile/search?q=FLAC%20Streaming&restrict_sr=1&sort=new')
    expect(parseRedditNote(threadNote({ title: 'Is FLAC worth it?', url: 'https://www.reddit.com/r/a/comments/x/', excerpt: 'Kurz' }))).toEqual({ kind: 'thread', title: 'Is FLAC worth it?', url: 'https://www.reddit.com/r/a/comments/x/', excerpt: 'Kurz' })
    expect(parseRedditNote(`Reddit-Zugang fehlt: ${url}`)).toEqual({ kind: 'access', url })
    expect(parseRedditNote(threadNote({ title: 'T', url: 'https://www.reddit.com/r/a/comments/x/', excerpt: 'Kurz', age: 'vor 3 Tagen' }))).toMatchObject({ age: 'vor 3 Tagen', excerpt: 'Kurz' })
    expect(parseRedditNote('Info nötig: x')).toBeNull()
  })

  it('nur aktive, offene Threads der letzten 7 Tage mit Bezug zum Thema', () => {
    const now = Date.now()
    const t = (id: string, o: Partial<RedditThread>): RedditThread => ({ id, sub: 'a', title: 'FLAC question', url: `https://www.reddit.com/r/a/comments/${id}/`, author: 'x', createdAt: new Date(now - 3_600_000).toISOString(), comments: 5, score: 1, locked: false, archived: false, text: '', ...o })
    const out = rankThreads([t('1', {}), t('2', { locked: true }), t('3', { archived: true }), t('4', { createdAt: new Date(now - 8 * 86_400_000).toISOString() }), t('5', { title: 'Cables' }), t('6', { comments: 80 }), t('1', {})], ['FLAC'], now)
    expect(out.map(x => x.id)).toEqual(['6', '1'])
  })

  it('App-only OAuth mit User-Agent, nur GET, Rate-Limit wird abgewartet', async () => {
    const m = mockFetch((url) => {
      if (url.includes('access_token')) return json({ access_token: 'tok', expires_in: 3600 })
      return json(listing(), 200, { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '2' })
    })
    const waits: number[] = []
    const c = new RedditClient({ clientId: 'cid', clientSecret: 'sec', user: 'peter' }, m.fn, async (ms) => {
      waits.push(ms)
    })
    await c.get('/r/audiophile/new', { limit: '5' })
    await c.get('/r/audiophile/new', { limit: '5' })
    expect(m.calls).toHaveLength(3)
    expect(m.calls[0]!.method).toBe('POST')
    expect(m.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`)
    expect(m.calls[0]!.body).toBe('grant_type=client_credentials')
    expect(m.calls.slice(1).every(x => x.method === 'GET' && x.headers.Authorization === 'Bearer tok' && x.headers['User-Agent'] === 'aimarage/1.0 by peter')).toBe(true)
    expect(m.calls[1]!.url).toBe('https://oauth.reddit.com/r/audiophile/new?limit=5&raw_json=1')
    expect(waits).toHaveLength(1)
  })

  it('ohne Reddit-Zugang: Antwort wartet auf Einrichtung, kein Entwurf, keine Frage', async () => {
    const task = await mkTask({})
    const web = mockFetch(() => {
      throw new Error('darf Reddit nicht aufrufen')
    })
    const l = llmMock({ kind: 'post', body: 'x' })
    const r = await runDraftTask(db, ws, task.id, l.fn, { webFetch: web.fn })
    expect(r.status).toBe('skipped')
    expect(web.calls).toHaveLength(0)
    expect(l.prompts).toHaveLength(0)
    expect(await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))).toHaveLength(0)
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))).map(n => n.text)
    expect(notes.filter(n => n.startsWith(REDDIT_SETUP))).toHaveLength(1)
    expect(notes.some(n => n.startsWith('Info nötig'))).toBe(false)
    const setup = await db.select().from(schema.tasks).where(eq(schema.tasks.origin, 'setup:reddit'))
    expect(setup).toHaveLength(1)
    await runDraftTask(db, ws, task.id, l.fn, { webFetch: web.fn })
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.origin, 'setup:reddit'))).toHaveLength(1)
  })

  it('bestehender Entwurf mit Info-nötig-Frage wird aus den Freigaben genommen', async () => {
    const task = await mkTask({ channel: 'r/lossless', status: 'entwurf_fertig' })
    await db.insert(schema.drafts).values({ taskId: task.id, version: 1, kind: 'post', body: 'Alt', byAgent: true, status: 'offen' })
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: 'Info nötig: Kannst du mir den Link eines aktiven Threads schicken?' })
    const other = await mkTask({ title: 'Beitrag: Neues Album', channel: 'r/lossless' })
    expect(await parkRedditTasks(db, ws)).toBe(1)
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('geplant')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    expect(d!.status).toBe('ersetzt')
    expect(await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, other.id))).toHaveLength(0)
    expect(await parkRedditTasks(db, ws)).toBe(0)
  })

  it('Schlüssel gespeichert: geparkte Aufgaben verlieren die Setup-Notiz und werden neu angestoßen', async () => {
    const task = await mkTask({ channel: 'r/lossless' })
    expect(await parkRedditTasks(db, ws)).toBe(1)
    expect(await resumeRedditTasks(db, ws)).toBeGreaterThan(0)
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))
    expect(notes.some(n => n.text.startsWith(REDDIT_SETUP))).toBe(false)
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))
    expect(jobs.some(j => (j.payload as { taskId?: string }).taskId === task.id)).toBe(true)
  })

  it('ohne Reddit-Zugang: eigener Beitrag als Vorlage, keine Frage nach Threads', async () => {
    const task = await mkTask({ title: 'Beitrag: FLAC vs. Streaming' })
    const web = mockFetch((url) => {
      if (/\/about(\/rules)?\.json/.test(url)) return json({ message: 'Blocked' }, 403)
      throw new Error('darf Reddit nicht aufrufen')
    })
    const l = llmMock({ kind: 'post', body: 'FLAC keeps every bit; most streaming is lossy. I run tonebase, a small lossless store.', missing: ['Welchen Thread meinst du?', 'Link zum passenden Forenbeitrag?', 'Wie heißt das neue Album?'] })
    await runDraftTask(db, ws, task.id, l.fn, { webFetch: web.fn })
    expect(web.calls.filter(c => !/\/about(\/rules)?\.json/.test(c.url))).toHaveLength(0)
    expect(l.prompts[0]).toContain('Reddit-Suche nicht eingerichtet')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    expect(d!.targetUrl).toBe('https://www.reddit.com/r/audiophile/search?q=FLAC%20Streaming&restrict_sr=1&sort=new')
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))).map(n => n.text)
    expect(notes).toContain(`Reddit-Zugang fehlt: ${d!.targetUrl}`)
    expect(notes).toContain('Info nötig: Wie heißt das neue Album?')
  })

  it('mit Reddit-Zugang: sucht Threads, schreibt auf den gewählten, Freigabe kennt Titel und Link', async () => {
    await updateSettings(db, ws.id, s => ({ ...s, apps: { ...s.apps, reddit: { clientId: 'rid', secret: sealAppSecret(ws.id, 'reddit', 'rsecret-123'), user: 'peter' } } }))
    await reloadWs()
    const task = await mkTask({})
    const web = mockFetch(redditApi)
    const l = llmMock({ kind: 'post', targetUrl: 'https://www.reddit.com/r/audiophile/comments/aa2/slug/', body: 'On a home setup FLAC matters once your DAC is decent. I run tonebase, a lossless store.' })
    await runDraftTask(db, ws, task.id, l.fn, { webFetch: web.fn })
    expect(web.calls.every(c => c.method === 'GET' || c.url.includes('access_token'))).toBe(true)
    expect(web.calls.some(c => c.url.includes('/r/audiophile/search?q=FLAC+Streaming&restrict_sr=1&sort=new&t=week'))).toBe(true)
    const prompt = l.prompts[0]!
    expect(prompt).toContain('Is FLAC worth it over Spotify streaming?')
    expect(prompt).toContain('Depends on your DAC.')
    expect(prompt).toContain('No self-promotion')
    expect(prompt).not.toContain('Locked FLAC')
    expect(prompt).not.toContain('Old FLAC thread')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id)).orderBy(desc(schema.drafts.version))
    expect(d!.targetUrl).toBe('https://www.reddit.com/r/audiophile/comments/aa2/slug/')
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))).map(n => parseRedditNote(n.text)).filter(Boolean)
    expect(notes).toEqual([{ kind: 'thread', title: 'Is FLAC worth it over Spotify streaming?', url: 'https://www.reddit.com/r/audiophile/comments/aa2/slug/', excerpt: 'Body of Is FLAC worth it over Spotify streaming?', age: 'vor 5 Std.' }])
  })

  it('Recherche nutzt die gefundenen Threads als Fundstellen', async () => {
    const task = await mkTask({ title: 'Recherche: FLAC Streaming in r/audiophile', channel: 'r/audiophile' })
    const l = llmMock({ kind: 'text', body: 'Fundstellen:\n1. Is FLAC worth it over Spotify streaming? - https://www.reddit.com/r/audiophile/comments/aa2/slug/ - gute Chance\nEmpfehlung:\n- antworten' })
    await runDraftTask(db, ws, task.id, l.fn, { webFetch: mockFetch(redditApi).fn })
    expect(l.prompts[0]).toContain('AUFGABENTYP: RECHERCHE')
    expect(l.prompts[0]).toContain('https://www.reddit.com/r/audiophile/comments/aa2/slug/')
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('erledigt')
  })
})

describe('Mit X anmelden (OAuth 2.0 mit PKCE)', () => {
  it('Start mit code_challenge, Rückkehr tauscht den Code mit code_verifier', async () => {
    await updateSettings(db, ws.id, s => ({ ...s, apps: { ...s.apps, x: { clientId: 'xcid', secret: sealAppSecret(ws.id, 'x', 'xsecret-123'), redirectUri: null } } }))
    await reloadWs()
    const url = new URL(await startOAuth(db, ws, 'x', project.id, 'http://localhost:3210'))
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize')
    expect(url.searchParams.get('scope')).toBe('tweet.read tweet.write users.read media.write offline.access')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3210/api/connect/x/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    await reloadWs()
    const pending = ws.settings!.oauthStates!.find(x => x.state === url.searchParams.get('state'))!
    expect(pkceChallenge(pending.verifier!)).toBe(url.searchParams.get('code_challenge'))
    const m = mockFetch((u) => {
      if (u.endsWith('/2/oauth2/token')) return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 7200, token_type: 'bearer' })
      if (u.endsWith('/2/users/me')) return json({ data: { id: '42', username: 'tonebase' } })
      return json({}, 404)
    })
    const [conn] = await finishOAuth(db, ws, 'x', 'the-code', pending.state, 'http://localhost:3210', m.fn)
    expect(conn!.name).toBe('@tonebase')
    const body = new URLSearchParams(m.calls[0]!.body)
    expect(body.get('code_verifier')).toBe(pending.verifier)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(m.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('xcid:xsecret-123').toString('base64')}`)
    expect(m.calls[1]!.headers.Authorization).toBe('Bearer at-1')
    await reloadWs()
    expect(JSON.stringify(ws.settings)).not.toContain('at-1')
    expect(ws.settings!.oauthStates!.some(x => x.state === pending.state)).toBe(false)
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id))
    expect(p!.setup?.social?.accountIds).toContain(conn!.id)
  })

  it('Access-Token abgelaufen: erneuert mit Refresh-Token, speichert neues Paar und postet mit Bearer', async () => {
    await reloadWs()
    const conn = listConnections(ws).find(c => c.provider === 'x')!
    const m = mockFetch((u) => {
      if (u.endsWith('/2/oauth2/token')) return json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 7200 })
      if (u.endsWith('/2/tweets')) return json({ data: { id: '999' } })
      return json({}, 404)
    })
    const ctx = adapterCtx(db, ws, conn, m.fn)
    const creds = { accessToken: 'at-1', refreshToken: 'rt-1', accessExpiresAt: new Date(Date.now() - 1000).toISOString() }
    const res = await xAdapter.post(conn, creds, { text: 'Hallo', media: [], link: null }, ctx)
    expect(res.url).toBe('https://x.com/tonebase/status/999')
    expect(new URLSearchParams(m.calls[0]!.body).get('refresh_token')).toBe('rt-1')
    expect(m.calls[1]!.headers.Authorization).toBe('Bearer at-2')
    expect(m.calls.filter(c => c.url.endsWith('/2/oauth2/token'))).toHaveLength(1)
    expect(await xToken(creds, ctx)).toBe('at-2')
  })

  it('Refresh abgelehnt: klare Meldung zum Neu-Verbinden', async () => {
    await reloadWs()
    const conn = listConnections(ws).find(c => c.provider === 'x')!
    const m = mockFetch(() => json({ error: 'invalid_request', error_description: 'Value passed for the token was invalid.' }, 400))
    await expect(xToken({ accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(0).toISOString() }, adapterCtx(db, ws, conn, m.fn))).rejects.toThrow('bitte neu verbinden')
  })
})
