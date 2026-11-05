import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finishOAuth, listConnections, openCreds, sealAppSecret, startOAuth, updateSettings } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { authorizeUrl, defaultRedirect } from '../../server/lib/platforms/oauth'
import type { AdapterCtx, Creds, SocialConn } from '../../server/lib/platforms/types'
import { CHUNK, videoTags, videoTitle, youtubeAdapter, youtubeExchange } from '../../server/lib/platforms/youtube'
import { resetSecretCache } from '../../server/lib/secret'
import { postIssues } from '../../shared/utils/social'
import { fakeMp4 } from './fixtures/mp4'

type Call = { url: string, method: string, headers: Record<string, string>, body: unknown, size: number }
type Reply = { status?: number, json?: unknown, headers?: Record<string, string> } | undefined

function mockFetch(handler: (c: Call, n: number) => Reply) {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    const body = init.body
    const c: Call = { url, method: String(init.method ?? 'GET'), headers: (init.headers ?? {}) as Record<string, string>, body: body instanceof URLSearchParams ? Object.fromEntries(body) : typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : body, size: body instanceof Uint8Array ? body.byteLength : 0 }
    calls.push(c)
    const r = handler(c, calls.length)
    if (!r) return new Response('{}', { status: 404 })
    const status = r.status ?? 200
    return new Response(status === 308 || r.json === undefined ? null : JSON.stringify(r.json), { status, headers: r.headers })
  }
  return { fn, calls }
}

const app = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'gsecret', redirectUri: 'http://localhost:3210/api/connect/google/callback' }
const conn: SocialConn = { id: 'y1', provider: 'youtube', platform: 'youtube', name: 'The Wanderer', handle: 'thewanderer', ext: { channelId: 'UC1', categoryId: '10', privacy: 'public' }, secret: { enc: '', hint: '', setAt: '' } }
const fresh: Creds = { refreshToken: 'r1', accessToken: 'a1', accessExpiresAt: new Date(Date.now() + 3600_000).toISOString() }
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xyz'

function ctxOf(fn: AdapterCtx['fetch'], saved: Creds[] = []): AdapterCtx {
  return { fetch: fn, sleep: async () => {}, app, saveCreds: async (c) => {
    saved.push(c)
  } }
}

function bigVideo(opts: { seconds: number, width: number, height: number }, size = CHUNK + 1000): { name: string, mime: string, data: Uint8Array } {
  const head = fakeMp4(opts)
  const data = new Uint8Array(size)
  data.set(head)
  return { name: 'v.mp4', mime: 'video/mp4', data }
}

function rangeOf(c: Call): [number, number, number] {
  const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(c.headers['Content-Range'] ?? '')!
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

describe('YouTube: Anmeldung über den Google-Zugang der Search Console', () => {
  it('Anmelde-Adresse mit youtube.upload, offline und Google-Weiterleitung', () => {
    expect(defaultRedirect('http://localhost:3210', 'youtube')).toBe('http://localhost:3210/api/connect/google/callback')
    const u = new URL(authorizeUrl('youtube', app, 's1'))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('redirect_uri')).toBe(app.redirectUri)
    expect(u.searchParams.get('state')).toBe('s1')
  })

  it('Code gegen Zugang tauschen, Kanal lesen', async () => {
    const { fn, calls } = mockFetch((c) => {
      if (c.url === 'https://oauth2.googleapis.com/token') return { json: { access_token: 'a1', refresh_token: 'r1', expires_in: 3599, scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' } }
      if (c.url.includes('/channels?')) return { json: { items: [{ id: 'UC1', snippet: { title: 'The Wanderer', customUrl: '@thewanderer' } }] } }
      return undefined
    })
    const [r] = await youtubeExchange(app, 'code1', fn)
    expect(calls[0]!.body).toMatchObject({ code: 'code1', grant_type: 'authorization_code', redirect_uri: app.redirectUri })
    expect(calls[1]!.headers).toMatchObject({ Authorization: 'Bearer a1' })
    expect(r!.conn).toMatchObject({ provider: 'youtube', platform: 'youtube', name: 'The Wanderer', handle: 'thewanderer', url: 'https://www.youtube.com/@thewanderer', ext: { channelId: 'UC1', categoryId: '22', privacy: 'public' } })
    expect(r!.creds).toMatchObject({ refreshToken: 'r1', accessToken: 'a1' })
  })

  it('ohne Kanal oder ohne Upload-Recht klare Fehler', async () => {
    const none = mockFetch(c => (c.url.includes('/token') ? { json: { access_token: 'a', refresh_token: 'r' } } : { json: { items: [] } }))
    await expect(youtubeExchange(app, 'c', none.fn)).rejects.toThrow(/keinen YouTube-Kanal/)
    const scope = mockFetch(() => ({ json: { access_token: 'a', refresh_token: 'r', scope: 'https://www.googleapis.com/auth/youtube.readonly' } }))
    await expect(youtubeExchange(app, 'c', scope.fn)).rejects.toThrow(/Hochladen wurde nicht erlaubt/)
  })
})

describe('YouTube: Video hochladen (Resumable Upload)', () => {
  it('Short: Metadaten, zwei Teile mit 308 und Range, Shorts-Link', async () => {
    const video = bigVideo({ seconds: 45, width: 1080, height: 1920 })
    const { fn, calls } = mockFetch((c) => {
      if (c.method === 'POST' && c.url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable')) return { headers: { Location: SESSION } }
      if (c.method === 'PUT' && c.url === SESSION) {
        const [, end, total] = rangeOf(c)
        return end + 1 < total ? { status: 308, headers: { Range: `bytes=0-${end}` } } : { status: 201, json: { id: 'vid1', status: { privacyStatus: 'public', uploadStatus: 'uploaded' } } }
      }
      return undefined
    })
    const r = await youtubeAdapter.post(conn, fresh, { text: 'Neuer Song der Visitors\nJetzt anhören: https://thewanderer.ai/?utm_source=youtube #indie #aimusic', media: [video], link: null, title: 'Neon Rain (Official Short)' }, ctxOf(fn))
    expect(r).toEqual({ platform: 'youtube', ok: true, postId: 'vid1', url: 'https://www.youtube.com/shorts/vid1' })
    const init = calls[0]!
    expect(init.url).toBe('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status')
    expect(init.headers).toMatchObject({ 'Authorization': 'Bearer a1', 'X-Upload-Content-Length': String(video.data.byteLength), 'X-Upload-Content-Type': 'video/mp4' })
    expect(init.body).toEqual({
      snippet: { title: 'Neon Rain (Official Short)', description: 'Neuer Song der Visitors\nJetzt anhören: https://thewanderer.ai/?utm_source=youtube #indie #aimusic\n\n#Shorts', tags: ['indie', 'aimusic'], categoryId: '10' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    })
    const puts = calls.filter(c => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(rangeOf(puts[0]!)).toEqual([0, CHUNK - 1, video.data.byteLength])
    expect(puts[0]!.size).toBe(CHUNK)
    expect(rangeOf(puts[1]!)).toEqual([CHUNK, video.data.byteLength - 1, video.data.byteLength])
  })

  it('Querformat: normales Video, Titel aus der ersten Zeile, KI-Kennzeichnung, abgelaufener Zugang wird erneuert', async () => {
    const video = bigVideo({ seconds: 240, width: 1920, height: 1080 }, 5000)
    const saved: Creds[] = []
    const { fn, calls } = mockFetch((c) => {
      if (c.url === 'https://oauth2.googleapis.com/token') return { json: { access_token: 'a2', expires_in: 3599 } }
      if (c.method === 'POST') return { headers: { Location: SESSION } }
      if (c.method === 'PUT') return { status: 200, json: { id: 'vid2', status: { privacyStatus: 'unlisted' } } }
      return undefined
    })
    const old = { ...fresh, accessExpiresAt: new Date(Date.now() - 1000).toISOString() }
    const r = await youtubeAdapter.post({ ...conn, ext: { ...conn.ext, privacy: 'unlisted', synthetic: 'true' } }, old, { text: 'Making-of im Studio #behindthescenes\nMehr: https://thewanderer.ai', media: [video], link: null }, ctxOf(fn, saved))
    expect(r.url).toBe('https://www.youtube.com/watch?v=vid2')
    expect(calls[0]!.body).toMatchObject({ refresh_token: 'r1', client_id: app.clientId, grant_type: 'refresh_token' })
    expect(saved[0]).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' })
    const meta = calls[1]!.body as { snippet: Record<string, unknown>, status: Record<string, unknown> }
    expect(meta.snippet.title).toBe('Making-of im Studio')
    expect(meta.snippet.description).not.toMatch(/#Shorts/)
    expect(meta.status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: true })
    expect(calls[2]!.headers.Authorization).toBe('Bearer a2')
  })

  it('Abbruch mitten im Upload: Status abfragen und ab der gemeldeten Stelle weiter', async () => {
    const video = bigVideo({ seconds: 20, width: 720, height: 1280 })
    let failed = false
    const { fn, calls } = mockFetch((c) => {
      if (c.method === 'POST') return { headers: { Location: SESSION } }
      const cr = c.headers['Content-Range'] ?? ''
      if (cr.startsWith('bytes */')) return { status: 308, headers: { Range: 'bytes=0-999' } }
      if (!failed) {
        failed = true
        return { status: 503, json: { error: { message: 'backend error' } } }
      }
      const [, end, total] = rangeOf(c)
      return end + 1 < total ? { status: 308, headers: { Range: `bytes=0-${end}` } } : { status: 201, json: { id: 'vid3', status: { privacyStatus: 'public' } } }
    })
    const r = await youtubeAdapter.post(conn, fresh, { text: 'x', media: [video], link: null }, ctxOf(fn))
    expect(r.postId).toBe('vid3')
    const puts = calls.filter(c => c.method === 'PUT')
    expect(puts[1]!.headers['Content-Range']).toBe(`bytes */${video.data.byteLength}`)
    expect(rangeOf(puts[2]!)[0]).toBe(1000)
  })

  it('Privat-Sperre wird als Hinweis gemeldet', async () => {
    const video = bigVideo({ seconds: 20, width: 720, height: 1280 }, 3000)
    const { fn } = mockFetch(c => (c.method === 'POST' ? { headers: { Location: SESSION } } : { status: 201, json: { id: 'vid4', status: { privacyStatus: 'private' } } }))
    const r = await youtubeAdapter.post(conn, fresh, { text: 'x', media: [video], link: null }, ctxOf(fn))
    expect(r.ok).toBe(true)
    expect(r.error).toMatch(/auf "private" gesetzt statt "public"/)
  })

  it('Fehlerfälle: kein Video, zwei Videos, Kontingent, abgelaufene Sitzung, API nicht aktiviert', async () => {
    const { fn, calls } = mockFetch(() => undefined)
    const v = bigVideo({ seconds: 20, width: 720, height: 1280 }, 3000)
    await expect(youtubeAdapter.post(conn, fresh, { text: 'x', media: [], link: null }, ctxOf(fn))).rejects.toThrow(/Video nötig/)
    await expect(youtubeAdapter.post(conn, fresh, { text: 'x', media: [v, v], link: null }, ctxOf(fn))).rejects.toThrow(/nur ein Video/)
    expect(calls).toHaveLength(0)
    const quota = mockFetch(() => ({ status: 403, json: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } }))
    await expect(youtubeAdapter.post(conn, fresh, { text: 'x', media: [v], link: null }, ctxOf(quota.fn))).rejects.toThrow(/Tageskontingent/)
    const off = mockFetch(() => ({ status: 403, json: { error: { code: 403, message: 'YouTube Data API v3 has not been used in project 123 before or it is disabled.' } } }))
    await expect(youtubeAdapter.post(conn, fresh, { text: 'x', media: [v], link: null }, ctxOf(off.fn))).rejects.toThrow(/nicht aktiviert/)
    const gone = mockFetch(c => (c.method === 'POST' ? { headers: { Location: SESSION } } : { status: 404, json: {} }))
    await expect(youtubeAdapter.post(conn, fresh, { text: 'x', media: [v], link: null }, ctxOf(gone.fn))).rejects.toThrow(/Upload-Sitzung abgelaufen/)
    const revoked = mockFetch(() => ({ status: 400, json: { error: 'invalid_grant' } }))
    await expect(youtubeAdapter.post(conn, { ...fresh, accessExpiresAt: '' }, { text: 'x', media: [v], link: null }, ctxOf(revoked.fn))).rejects.toThrow(/neu verbinden/)
  })

  it('Titel, Tags und Prüfung', () => {
    expect(videoTitle(null, '#tag https://x.y\n\nErste echte Zeile <b> #mehr')).toBe('Erste echte Zeile b')
    expect([...videoTitle(null, 'a'.repeat(150))]).toHaveLength(100)
    expect(videoTags('#Indie #indie #Shorts #ai_music text#nope')).toEqual(['Indie', 'ai_music'])
    expect(postIssues('youtube', 'x', [{ mime: 'image/jpeg' }])).toEqual(['video_needed'])
  })

  it('Zahlen in social_stats und Abonnenten', async () => {
    const { fn, calls } = mockFetch((c) => {
      if (c.url.includes('/videos?part=statistics&id=vid1')) return { json: { items: [{ statistics: { viewCount: '1200', likeCount: '80', commentCount: '7' } }] } }
      if (c.url.includes('/channels?')) return { json: { items: [{ id: 'UC1', statistics: { subscriberCount: '345', hiddenSubscriberCount: false } }] } }
      return undefined
    })
    expect(await youtubeAdapter.stats!(conn, fresh, { postId: 'vid1', url: null }, ctxOf(fn))).toEqual({ views: 1200, likes: 80, comments: 7 })
    expect(await youtubeAdapter.followers!(conn, fresh, ctxOf(fn))).toBe(345)
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer a1' })
  })
})

describe('YouTube verbinden mit gespeichertem Google-Zugang', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  beforeAll(async () => {
    process.env.APP_SECRET = 'test-secret'
    resetSecretCache()
    ;({ db, close } = await openTestDb())
    ;[ws] = await db.insert(schema.workspaces).values({ name: 'Test' }).returning() as [typeof ws]
    await updateSettings(db, ws.id, s => ({ ...s, apps: { google: { clientId: app.clientId, secret: sealAppSecret(ws.id, 'google', app.clientSecret) } } }))
    ws = (await db.select().from(schema.workspaces))[0]!
  })
  afterAll(async () => {
    delete process.env.APP_SECRET
    resetSecretCache()
    await close()
  })
  it('Start nutzt Client-ID und Weiterleitung von Google, Abschluss legt die Verbindung an', async () => {
    const url = new URL(await startOAuth(db, ws, 'youtube', null, 'http://localhost:3210'))
    expect(url.searchParams.get('client_id')).toBe(app.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3210/api/connect/google/callback')
    ws = (await db.select().from(schema.workspaces))[0]!
    const state = url.searchParams.get('state')!
    expect(ws.settings?.oauthStates?.find(x => x.state === state)?.provider).toBe('youtube')
    const { fn, calls } = mockFetch((c) => {
      if (c.url.includes('/token')) return { json: { access_token: 'a1', refresh_token: 'r1', expires_in: 3599 } }
      return { json: { items: [{ id: 'UC1', snippet: { title: 'The Wanderer' } }] } }
    })
    const [saved] = await finishOAuth(db, ws, 'youtube', 'code1', state, 'http://localhost:3210', fn)
    expect((calls[0]!.body as Record<string, string>).client_secret).toBe(app.clientSecret)
    ws = (await db.select().from(schema.workspaces))[0]!
    const c = listConnections(ws).find(x => x.id === saved!.id)!
    expect(c).toMatchObject({ provider: 'youtube', platform: 'youtube', name: 'The Wanderer', url: 'https://www.youtube.com/channel/UC1' })
    expect(openCreds(ws.id, c)).toMatchObject({ refreshToken: 'r1' })
  })
})
