import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runDraftTask, runSocialStats } from '../../server/lib/agent'
import { checkConnection, listConnections, upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { saveMedia } from '../../server/lib/media'
import { decidePublish } from '../../server/lib/outlets'
import { bskyFacets } from '../../server/lib/platforms/bluesky'
import { littleText } from '../../server/lib/platforms/linkedin'
import { parsePastedRedirect } from '../../server/lib/platforms/oauth'
import { chunking } from '../../server/lib/platforms/tiktok'
import { oauth1Header } from '../../server/lib/platforms/x'
import { checkPostStatus, outletReady, PublishError, publishPost, schedulePost, socialTarget, zonedToUtc } from '../../server/lib/publish'
import { resetSecretCache } from '../../server/lib/secret'
import { applySocialUpdate } from '../../server/lib/social'
import { buildForm, outcomeOf } from '../../server/lib/uploadpost'
import { hasPlaceholder, mediaNeed, postIssues } from '../../shared/utils/social'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let ownerId: string
let seq = 0

type Call = { url: string, method: string, body?: unknown, headers?: Record<string, string> }

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method ?? 'GET'), body: init.body, headers: init.headers as Record<string, string> })
    return handler(url, init)
  }
  return { fn, calls }
}

const json = (d: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...headers } })

function bskyOk(url: string): Response {
  if (url.endsWith('createSession')) return json({ accessJwt: 'jwt', did: 'did:plc:abc', handle: 'tonebase.bsky.social' })
  if (url.endsWith('uploadBlob')) return json({ blob: { $type: 'blob', ref: { $link: 'x' }, mimeType: 'image/png', size: 10 } })
  if (url.endsWith('createRecord')) return json({ uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz', cid: 'c' })
  if (url.includes('getPosts')) return json({ posts: [{ likeCount: 5, repostCount: 2, quoteCount: 1, replyCount: 3 }] })
  if (url.includes('getProfile')) return json({ followersCount: 120 })
  if (url.startsWith('https://tonebase.com')) return new Response('<title>tonebase</title>', { status: 200 })
  return json({}, 404)
}

async function reloadWs() {
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}

async function makeTask(opts: { category?: 'social' | 'community', status?: 'geplant' | 'entwurf_fertig' | 'freigegeben', body?: string, dueDate?: string, dueTime?: string } = {}) {
  seq++
  const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `T-${seq}`, title: `Post ${seq}`, category: opts.category ?? 'social', status: opts.status ?? 'freigegeben', draftKind: 'post', dueDate: opts.dueDate ?? '2026-10-13', dueTime: opts.dueTime ?? '11:00', agentStep: 'Beitrag entwerfen' }).returning()
  const [draft] = await db.insert(schema.drafts).values({ taskId: task!.id, version: 1, kind: 'post', body: opts.body ?? 'Neuer Song bei tonebase https://tonebase.com #indie', status: opts.status === 'entwurf_fertig' || opts.status === 'geplant' ? 'offen' : 'freigegeben', approvedAt: new Date() }).returning()
  return { task: task!, draft: draft! }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'ma-media-'))
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  const [w] = await db.insert(schema.workspaces).values({ name: 'Test' }).returning()
  ws = w!
  const [u] = await db.insert(schema.users).values({ email: 'p@test.local', name: 'Peter' }).returning()
  ownerId = u!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: ownerId, role: 'owner' })
  const [p] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'music', url: 'https://tonebase.com' }).returning()
  project = p!
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  delete process.env.MEDIA_DIR
  resetSecretCache()
  await close()
})

describe('Plattform-Regeln und Hilfen', () => {
  it('Pflichtmedien, Länge, nie automatisch', () => {
    expect(postIssues('instagram', 'Hallo', [])).toEqual(['image_needed'])
    expect(postIssues('instagram', 'Hallo', [{ mime: 'image/jpeg' }])).toEqual([])
    expect(postIssues('tiktok', 'Hallo', [{ mime: 'image/jpeg' }])).toEqual(['video_needed'])
    expect(postIssues('bluesky', 'x'.repeat(301), [])).toEqual(['too_long'])
    expect(postIssues('reddit', 'Hallo', [])).toContain('not_supported')
    expect(mediaNeed(['x', 'instagram'])).toBe('image_or_video')
  })
  it('Bluesky-Facets in UTF-8-Bytes', () => {
    const f = bskyFacets('Grüße https://tonebase.com. #indie')
    expect(f[0]!.index).toEqual({ byteStart: 8, byteEnd: 28 })
    expect(f[1]!.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#tag', tag: 'indie' })
  })
  it('X OAuth 1.0a Signatur (Beispiel aus der X-Doku)', () => {
    const h = oauth1Header('POST', 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true', { consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' }, { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' }, 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', '1318622958')
    expect(h).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"')
  })
  it('OAuth-Adresse einfügen, LinkedIn-Text, TikTok-Stücke, Zeitzone', () => {
    expect(parsePastedRedirect('https://tonebase.com/thewanderer/tiktok/?code=abc%2A1&scopes=x&state=s1')).toEqual({ code: 'abc*1', state: 's1' })
    expect(parsePastedRedirect('https://x.test/cb?code=AQ#_').code).toBe('AQ')
    expect(() => parsePastedRedirect('https://x.test/cb?error=access_denied')).toThrow(/access_denied/)
    expect(littleText('Hallo (Welt) @tonebase')).toBe('Hallo \\(Welt\\) \\@tonebase')
    expect(chunking(10)).toEqual({ chunkSize: 10, count: 1 })
    expect(chunking(150 * 1024 * 1024).count).toBe(15)
    expect(zonedToUtc('2026-10-15', '11:00', 'Europe/Vienna').toISOString()).toBe('2026-10-15T09:00:00.000Z')
    expect(zonedToUtc('2026-11-05', '11:00', 'Europe/Vienna').toISOString()).toBe('2026-11-05T10:00:00.000Z')
  })
  it('Upload-Post: Formular und Antworten', async () => {
    const fd = buildForm({ profile: 'tonebase', platforms: ['x', 'linkedin'], text: 'Hallo', variants: { x: 'Kurz' }, media: [], at: null, timezone: 'Europe/Vienna', externalId: 'e1' })
    expect(fd.getAll('platform[]')).toEqual(['x', 'linkedin'])
    expect(fd.get('x_title')).toBe('Kurz')
    expect(fd.get('async_upload')).toBe('true')
    expect(outcomeOf({ success: true, request_id: 'r1' }, ['x']).state).toBe('pending')
    const done = outcomeOf({ success: true, results: { x: { success: true, url: 'https://x.com/a/status/1' }, linkedin: { success: false, error: 'Expired access token' } } }, ['x', 'linkedin'])
    expect(done.state).toBe('done')
    expect(done.results.find(r => r.platform === 'linkedin')).toMatchObject({ ok: false, error: 'Expired access token' })
    expect(outcomeOf({ status: 'completed', results: [{ platform: 'x', success: true, status: 'completed', post_url: 'u' }] }, []).results[0]).toMatchObject({ ok: true, url: 'u' })
  })
})

describe('Posten über eigene Verbindungen', () => {
  beforeEach(async () => {
    await reloadWs()
  })

  it('ohne zugeordnetes Konto kein Ausgang, Community nie', async () => {
    expect(outletReady(ws, project)).toBe(false)
    const { task, draft } = await makeTask({ category: 'community' })
    await expect(schedulePost(db, ws, { task, draft, project, mode: 'manual', at: new Date() })).rejects.toThrow(PublishError)
  })

  it('Bluesky verbinden, Trockenlauf solange der Schalter aus ist', async () => {
    const conn = await upsertConnection(db, ws.id, { provider: 'bluesky', platform: 'bluesky', name: '@tonebase.bsky.social', handle: 'tonebase.bsky.social', ext: { did: 'did:plc:abc' } }, { identifier: 'tonebase.bsky.social', password: 'app-pass-1234' }, { projectId: project.id })
    await reloadWs()
    expect(JSON.stringify(ws.settings)).not.toContain('app-pass-1234')
    expect(listConnections(ws)).toHaveLength(1)
    expect(socialTarget(ws, project)!.platforms.map(p => p.platform)).toEqual(['bluesky'])
    const m = mockFetch(bskyOk)
    expect(await checkConnection(db, ws, conn.id, m.fn)).toEqual({ ok: true, name: '@tonebase.bsky.social' })
    const { task, draft } = await makeTask()
    const post = await schedulePost(db, ws, { task, draft, project, mode: 'manual', at: new Date('2026-10-13T06:00:00Z') })
    const calls = mockFetch(() => {
      throw new Error('darf nicht senden')
    })
    const r = await publishPost(db, ws, post.id, calls.fn)
    expect(r.summary).toMatch(/Trockenlauf/)
    expect(calls.calls).toHaveLength(0)
    const [row] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, post.id))
    expect(row!.status).toBe('trocken')
    const [act] = await db.select().from(schema.activity).where(and(eq(schema.activity.taskId, task.id), eq(schema.activity.action, 'social_dry_run')))
    expect(act).toBeTruthy()
  })

  it('Schalter an: postet, speichert Link, Aufgabe erledigt; Zahlen landen als Ergebnisse', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, publishLive: true } }).where(eq(schema.workspaces.id, ws.id))
    await reloadWs()
    const { task, draft } = await makeTask()
    const post = await schedulePost(db, ws, { task, draft, project, mode: 'auto_report', at: new Date('2026-10-13T06:00:00Z') })
    const m = mockFetch(bskyOk)
    const r = await publishPost(db, ws, post.id, m.fn)
    expect(r.status).toBe('ok')
    const rec = m.calls.find(c => c.url.endsWith('createRecord'))!
    const record = JSON.parse(String(rec.body)).record
    expect(record.embed.$type).toBe('app.bsky.embed.external')
    expect(record.facets.length).toBe(2)
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('erledigt')
    expect(t!.postedUrl).toBe('https://bsky.app/profile/tonebase.bsky.social/post/3kxyz')
    const links = await db.select().from(schema.taskLinks).where(eq(schema.taskLinks.taskId, task.id))
    expect(links.map(l => [l.platform, l.url])).toEqual([['bluesky', 'https://bsky.app/profile/tonebase.bsky.social/post/3kxyz']])
    const [act] = await db.select().from(schema.activity).where(and(eq(schema.activity.taskId, task.id), eq(schema.activity.action, 'social_posted_report')))
    expect(act).toBeTruthy()
    expect(await publishPost(db, ws, post.id, m.fn)).toMatchObject({ status: 'skipped' })
    await runSocialStats(db, ws, mockFetch(bskyOk).fn)
    const res = await db.select().from(schema.results).where(eq(schema.results.taskId, task.id))
    expect(Object.fromEntries(res.map(x => [x.metric, x.value]))).toMatchObject({ likes: 5, shares: 3, comments: 3 })
    await runSocialStats(db, ws, mockFetch(bskyOk).fn)
    expect(await db.select().from(schema.results).where(eq(schema.results.taskId, task.id))).toHaveLength(3)
    const [fol] = await db.select().from(schema.metrics).where(and(eq(schema.metrics.projectId, project.id), eq(schema.metrics.key, 'followers')))
    expect(fol!.value).toBe(120)
  })

  it('Fehler: Aufgabe zurück an Peter mit klarer Meldung', async () => {
    const { task, draft } = await makeTask()
    const post = await schedulePost(db, ws, { task, draft, project, mode: 'auto', at: new Date('2026-10-13T06:00:00Z') })
    const m = mockFetch(url => (url.endsWith('createSession') ? json({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }, 401) : json({})))
    const r = await publishPost(db, ws, post.id, m.fn)
    expect(r.status).toBe('error')
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('entwurf_fertig')
    expect(t!.assigneeUserId).toBe(ownerId)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(d!.status).toBe('offen')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))
    expect(notes.map(n => n.text).join()).toMatch(/Posten fehlgeschlagen: Bluesky: Bluesky: Handle oder App-Passwort falsch/)
    await reloadWs()
    expect(listConnections(ws)[0]!.error).toMatch(/App-Passwort/)
  })

  it('Instagram ohne Bild wird nicht geplant, mit Bild schon; geänderter Entwurf bricht ab', async () => {
    await upsertConnection(db, ws.id, { provider: 'meta', platform: 'instagram', name: '@tonebase', handle: 'tonebase', ext: { igUserId: '17841', pageId: '1001' } }, { accessToken: 'page-token' }, { projectId: project.id })
    await reloadWs()
    const { task, draft } = await makeTask()
    await expect(schedulePost(db, ws, { task, draft, project, mode: 'manual', at: new Date() })).rejects.toThrow(/Instagram: Bild oder Video nötig/)
    const media = await saveMedia(ws.id, draft.id, { name: 'cover.jpg', data: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]) })
    await db.update(schema.drafts).set({ media: [media], platforms: ['instagram'] }).where(eq(schema.drafts.id, draft.id))
    const d2 = (await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id)))[0]!
    const post = await schedulePost(db, ws, { task, draft: d2, project, mode: 'manual', at: new Date('2026-10-13T06:00:00Z') })
    expect(post.platforms).toEqual(['instagram'])
    await db.update(schema.drafts).set({ status: 'ersetzt' }).where(eq(schema.drafts.id, draft.id))
    expect((await publishPost(db, ws, post.id, mockFetch(() => json({})).fn)).summary).toMatch(/Abgebrochen/)
  })

  it('Instagram: Bild über Facebook-Seite bereitstellen, Container, Veröffentlichen', async () => {
    const { task, draft } = await makeTask()
    const media = await saveMedia(ws.id, draft.id, { name: 'cover.jpg', data: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]) })
    await db.update(schema.drafts).set({ media: [media], platforms: ['instagram'] }).where(eq(schema.drafts.id, draft.id))
    const d2 = (await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id)))[0]!
    const post = await schedulePost(db, ws, { task, draft: d2, project, mode: 'manual', at: new Date('2026-10-13T06:00:00Z') })
    const m = mockFetch((url) => {
      if (url.includes('/1001/photos')) return json({ id: 'ph1' })
      if (url.includes('/ph1?')) return json({ images: [{ source: 'https://scontent.fbcdn.net/x.jpg' }] })
      if (url.includes('/17841/media_publish')) return json({ id: 'ig1' })
      if (url.includes('/17841/media')) return json({ id: 'cont1' })
      if (url.includes('/cont1?')) return json({ status_code: 'FINISHED' })
      if (url.includes('/ig1?')) return json({ permalink: 'https://www.instagram.com/p/abc/' })
      return json({}, 404)
    })
    const r = await publishPost(db, ws, post.id, m.fn)
    expect(r.status).toBe('ok')
    const create = m.calls.find(c => c.url.endsWith('/17841/media'))!
    expect(String(create.body)).toContain('image_url=https%3A%2F%2Fscontent.fbcdn.net%2Fx.jpg')
    const [row] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, post.id))
    expect(row!.results[0]).toMatchObject({ platform: 'instagram', ok: true, url: 'https://www.instagram.com/p/abc/' })
  })
})

describe('Upload-Post als optionaler Adapter', () => {
  it('Profil-Konten, asynchron, Status bis fertig', async () => {
    const social = { ...applySocialUpdate(undefined, { apiKey: 'up-key-123456789' }, ws.id), accounts: [{ id: 'tonebase:linkedin', platform: 'linkedin', name: 'Peter', profileId: 'tonebase', profileName: 'tonebase' }] }
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, social } }).where(eq(schema.workspaces.id, ws.id))
    await db.update(schema.projects).set({ setup: { ...project.setup, social: { ...project.setup.social, profileIds: ['tonebase'] } } }).where(eq(schema.projects.id, project.id))
    await reloadWs()
    const target = socialTarget(ws, project)!
    expect(target.platforms.find(p => p.platform === 'linkedin')!.via).toBe('up:tonebase')
    const { task, draft } = await makeTask()
    await db.update(schema.drafts).set({ platforms: ['linkedin', 'bluesky'] }).where(eq(schema.drafts.id, draft.id))
    const d2 = (await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id)))[0]!
    const post = await schedulePost(db, ws, { task, draft: d2, project, mode: 'manual', at: new Date('2026-10-13T06:00:00Z') })
    const m = mockFetch((url, init) => {
      if (url.endsWith('/upload_text')) {
        const fd = init.body as FormData
        expect(fd.getAll('platform[]')).toEqual(['linkedin'])
        expect((init.headers as Record<string, string>).Authorization).toBe('Apikey up-key-123456789')
        return json({ success: true, request_id: 'req-1' })
      }
      if (url.includes('/uploadposts/status')) return json({ status: 'completed', results: [{ platform: 'linkedin', success: true, status: 'completed' }] })
      if (url.includes('/uploadposts/history')) return json({ history: [{ platform: 'linkedin', success: true, post_url: 'https://www.linkedin.com/feed/update/urn:li:share:1/' }] })
      return bskyOk(url)
    })
    const r = await publishPost(db, ws, post.id, m.fn)
    expect(r.summary).toMatch(/warte auf Rückmeldung/)
    const job = (await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'publish_status')))[0]!
    expect(job.payload.postId).toBe(post.id)
    await checkPostStatus(db, ws, post.id, m.fn)
    const [row] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, post.id))
    expect(row!.status).toBe('gepostet')
    expect(row!.results.map(x => [x.platform, x.ok])).toEqual([['linkedin', true], ['bluesky', true]])
    expect(row!.results[0]!.url).toContain('linkedin.com')
  })
})

describe('Agent entwirft plattformgerecht und plant selbst', () => {
  it('Stufe "macht selbst": Fassungen je Plattform, freigegeben und geplant', async () => {
    await db.update(schema.projects).set({ autonomy: { social: 'auto' }, setup: { social: { accountIds: listConnections(ws).filter(c => c.platform === 'bluesky').map(c => c.id) } } }).where(eq(schema.projects.id, project.id))
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, social: undefined, llm: { provider: 'ollama', model: 'mock' } } }).where(eq(schema.workspaces.id, ws.id))
    await reloadWs()
    const { task } = await makeTask({ status: 'geplant', dueDate: '2026-10-15', dueTime: '11:00' })
    await db.delete(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    let prompt = ''
    const llm = mockFetch((_url, init) => {
      prompt ||= JSON.parse(String(init.body)).messages[1].content
      return json({ model: 'mock', choices: [{ message: { content: JSON.stringify({ kind: 'post', body: 'Allgemein https://tonebase.com', variants: { bluesky: 'Kurz für Bluesky https://tonebase.com #indie', x: 'nicht verbunden' }, media: 'none' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    })
    await runDraftTask(db, ws, task.id, llm.fn as typeof fetch)
    expect(prompt).toContain('bluesky (Bluesky): max. 300 Zeichen')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    expect(d!.variants).toEqual({ bluesky: `Kurz für Bluesky https://tonebase.com/?utm_source=bluesky&utm_medium=social&utm_campaign=${task.code.toLowerCase()} #indie` })
    expect(d!.body).toBe(`Allgemein https://tonebase.com/?utm_source=direkt&utm_medium=social&utm_campaign=${task.code.toLowerCase()}`)
    expect(d!.status).toBe('freigegeben')
    const [p] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, task.id))
    expect(p!.mode).toBe('auto')
    expect(p!.scheduledAt.toISOString()).toBe('2026-10-15T09:00:00.000Z')
    expect(decidePublish({ social: 'auto' }, task, false)).toEqual({ action: 'approve', reason: 'no_outlet' })
  })
})

describe('Pacing', () => {
  it('höchstens 1 Post je Plattform und Tag: zweiter rutscht auf morgen', async () => {
    const [p2] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'visitors', name: 'The Wanderer', code: 'TV', icon: 'TV', setup: { pacing: { perPlatformPerDay: 1 }, social: { accountIds: listConnections(ws).filter(c => c.platform === 'bluesky').map(c => c.id) } } }).returning()
    const mk = async () => {
      const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p2!.id, code: `TV-${++seq}`, title: 'Post', category: 'social', status: 'freigegeben', draftKind: 'post', dueDate: '2026-10-14', dueTime: '10:00' }).returning()
      const [draft] = await db.insert(schema.drafts).values({ taskId: task!.id, kind: 'post', body: 'Neuer Track', status: 'freigegeben' }).returning()
      return schedulePost(db, ws, { task: task!, draft: draft!, project: p2!, mode: 'auto', at: new Date('2026-10-14T08:00:00Z') })
    }
    expect((await mk()).scheduledAt.toISOString()).toBe('2026-10-14T08:00:00.000Z')
    expect((await mk()).scheduledAt.toISOString()).toBe('2026-10-15T08:00:00.000Z')
  })
})

describe('Platzhalter', () => {
  it('erkennt Platzhalter, aber keine Markdown-Links', () => {
    expect(hasPlaceholder('We just released [Artist Name]\'s [Track Name].')).toBe(true)
    expect(hasPlaceholder('Hi {{name}}')).toBe(true)
    expect(hasPlaceholder('[Listen to The Wanderer](https://thewandererai.com)')).toBe(false)
    expect(hasPlaceholder('Lossless, no DRM. https://tonebase.com')).toBe(false)
    expect(postIssues('bluesky', 'New track: [Track Name]', [])).toContain('placeholder')
  })
})

describe('Fassungen je Plattform und Bild', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
  const site = (url: string) => {
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 })
    if (url.endsWith('/cover.png')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
    return new Response('<title>tonebase</title><meta property="og:image" content="/cover.png">', { status: 200, headers: { 'content-type': 'text/html' } })
  }

  beforeAll(async () => {
    await reloadWs()
    await upsertConnection(db, ws.id, { provider: 'mastodon', platform: 'mastodon', name: '@tonebase@mastodon.social', handle: 'tonebase@mastodon.social', url: 'https://mastodon.social' }, { token: 'masto-token' }, { projectId: project.id })
    await reloadWs()
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, publishLive: true } }).where(eq(schema.workspaces.id, ws.id))
    await db.update(schema.projects).set({ autonomy: {} }).where(eq(schema.projects.id, project.id))
    await reloadWs()
  })

  it('Publish nimmt je Plattform die passende Fassung', async () => {
    const { task, draft } = await makeTask({ body: 'Allgemeiner Text https://tonebase.com' })
    await db.update(schema.drafts).set({ platforms: ['bluesky', 'mastodon'], variants: { bluesky: 'Bluesky-Fassung https://tonebase.com', mastodon: 'Mastodon-Fassung https://tonebase.com #FLAC #Lossless' } }).where(eq(schema.drafts.id, draft.id))
    const d2 = (await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id)))[0]!
    const post = await schedulePost(db, ws, { task, draft: d2, project, mode: 'manual', at: new Date('2026-10-13T06:00:00Z') })
    const m = mockFetch((url) => {
      if (url.endsWith('/api/v1/statuses')) return json({ id: '42', url: 'https://mastodon.social/@tonebase/42' })
      return bskyOk(url)
    })
    const r = await publishPost(db, ws, post.id, m.fn)
    expect(r.status).toBe('ok')
    const record = JSON.parse(String(m.calls.find(c => c.url.endsWith('createRecord'))!.body)).record
    const camp = task.code.toLowerCase()
    expect(record.text).toBe('Bluesky-Fassung tonebase.com?utm_source=b...')
    expect(record.facets[0].features[0].uri).toBe(`https://tonebase.com/?utm_source=bluesky&utm_medium=social&utm_campaign=${camp}`)
    expect(JSON.parse(String(m.calls.find(c => c.url.endsWith('/api/v1/statuses'))!.body)).status).toBe(`Mastodon-Fassung https://tonebase.com/?utm_source=mastodon&utm_medium=social&utm_campaign=${camp} #FLAC #Lossless`)
  })

  it('Bluesky: Bild über 1 MB wird nicht hochgeladen, stattdessen Link-Karte mit Vorschaubild', async () => {
    const { task, draft } = await makeTask({ body: 'Neu https://tonebase.com' })
    const big = new Uint8Array(1_200_000)
    big.set(png)
    const media = await saveMedia(ws.id, draft.id, { name: 'cover.png', data: big })
    await db.update(schema.drafts).set({ media: [media], platforms: ['bluesky'] }).where(eq(schema.drafts.id, draft.id))
    const d2 = (await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id)))[0]!
    const post = await schedulePost(db, ws, { task, draft: d2, project, mode: 'manual', at: new Date('2026-10-13T06:00:00Z') })
    const m = mockFetch(url => (url.startsWith('https://tonebase.com') ? site(url) : bskyOk(url)))
    expect((await publishPost(db, ws, post.id, m.fn)).status).toBe('ok')
    const record = JSON.parse(String(m.calls.find(c => c.url.endsWith('createRecord'))!.body)).record
    expect(record.embed.$type).toBe('app.bsky.embed.external')
    expect(record.embed.external.thumb).toBeTruthy()
    expect(m.calls.filter(c => c.url.endsWith('uploadBlob'))).toHaveLength(1)
  })

  it('Agent: Fassung je Plattform mit Link, Bild der Projektseite wird angehängt', async () => {
    const { task } = await makeTask({ status: 'geplant' })
    await db.delete(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    let prompt = ''
    const llm = mockFetch((_url, init) => {
      prompt ||= JSON.parse(String(init.body)).messages[1].content
      return json({ model: 'mock', choices: [{ message: { content: JSON.stringify({ kind: 'post', body: 'Lossless, direkt vom Artist. https://tonebase.com', variants: { bluesky: 'Kurz für Bluesky https://tonebase.com', mastodon: 'Länger für Mastodon https://tonebase.com #FLAC #Lossless' } }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    })
    const web = mockFetch(site)
    await runDraftTask(db, ws, task.id, llm.fn as typeof fetch, { webFetch: web.fn as typeof fetch })
    expect(prompt).toContain('WERBE-GRUNDREGELN')
    expect(prompt).toMatch(/mastodon \(Mastodon\): max\. 500 Zeichen.*2-4 Hashtags, Link https:\/\/tonebase\.com\/\?utm_source=/)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    expect(Object.keys(d!.variants).sort()).toEqual(['bluesky', 'mastodon'])
    expect(d!.media).toHaveLength(1)
    expect(d!.media[0]!.mime).toBe('image/png')
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))).map(n => n.text)
    expect(notes.some(n => n.startsWith('Bild von der Projektseite angehängt: https://tonebase.com/cover.png'))).toBe(true)
    expect(notes.some(n => n.startsWith('Nachprüfung'))).toBe(false)
  })

  it('Agent: Link auf Unterseite bekommt UTM je Fassung, Bild kommt von der verlinkten Seite', async () => {
    const { task } = await makeTask({ status: 'geplant' })
    await db.delete(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    const album = 'https://tonebase.com/artists/the-wanderer/album/superposition'
    const llm = mockFetch(() => json({ model: 'mock', choices: [{ message: { content: JSON.stringify({ kind: 'post', body: `Superposition ist da: ${album}`, variants: { bluesky: `Superposition, lossless: ${album}`, mastodon: `Superposition, lossless und ohne DRM: ${album}?ref=x. #FLAC #Lossless` } }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    const web = mockFetch((url) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 })
      if (url.endsWith('.png')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
      if (url.includes('/album/')) return new Response('<title>Superposition</title><meta property="og:image" content="/covers/superposition.png">', { status: 200, headers: { 'content-type': 'text/html' } })
      return new Response('<title>tonebase</title><meta property="og:image" content="/cover.png">', { status: 200, headers: { 'content-type': 'text/html' } })
    })
    await runDraftTask(db, ws, task.id, llm.fn as typeof fetch, { webFetch: web.fn as typeof fetch })
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    const camp = task.code.toLowerCase()
    expect(d!.variants.bluesky).toBe(`Superposition, lossless: ${album}?utm_source=bluesky&utm_medium=social&utm_campaign=${camp}`)
    expect(d!.variants.mastodon).toBe(`Superposition, lossless und ohne DRM: ${album}?ref=x&utm_source=mastodon&utm_medium=social&utm_campaign=${camp}. #FLAC #Lossless`)
    expect(web.calls.some(c => c.url.includes('/album/superposition') && !c.url.includes('utm_'))).toBe(true)
    expect(web.calls.some(c => c.url.endsWith('/covers/superposition.png'))).toBe(true)
    expect(web.calls.some(c => c.url === 'https://tonebase.com/cover.png')).toBe(false)
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))).map(n => n.text)
    expect(notes.some(n => n.startsWith(`Bild der verlinkten Seite ${album} angehängt: https://tonebase.com/covers/superposition.png`))).toBe(true)
  })
})
