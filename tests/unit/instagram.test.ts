import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listConnections, openCreds, refreshTokens, upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { isPublicBase, mediaLink, openMediaLink } from '../../server/lib/media-link'
import { authorizeUrl } from '../../server/lib/platforms/oauth'
import { instagramAdapter, instagramExchange, needsRefresh, PUBLIC_MEDIA_HINT } from '../../server/lib/platforms/instagram'
import type { AdapterCtx, Creds, SocialConn } from '../../server/lib/platforms/types'
import { resetSecretCache } from '../../server/lib/secret'
import { postIssues } from '../../shared/utils/social'

type Call = { url: string, method: string, body: Record<string, string> }

function mockFetch(handler: (url: string, method: string) => unknown) {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    const method = String(init.method ?? 'GET')
    calls.push({ url, method, body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {} })
    const d = handler(url, method)
    if (d instanceof Response) return d
    return new Response(JSON.stringify(d ?? {}), { status: d === undefined ? 404 : 200, headers: { 'content-type': 'application/json' } })
  }
  return { fn, calls }
}

const app = { clientId: '123', clientSecret: 'geheim', redirectUri: 'https://aimarage.com/api/connect/instagram/callback' }
const conn: SocialConn = { id: 'c1', provider: 'instagram', platform: 'instagram', name: '@thewandereraiband', handle: 'thewandereraiband', ext: { igUserId: '1789' }, secret: { enc: '', hint: '', setAt: '' }, expiresAt: new Date(Date.now() + 50 * 86_400_000).toISOString() }
const creds: Creds = { accessToken: 'IGAAlong', issuedAt: new Date().toISOString() }
const jpg = { name: 'a.jpg', mime: 'image/jpeg', data: new Uint8Array([0xFF, 0xD8, 0xFF]), url: 'https://aimarage.com/m/t1.jpg' }

function ctxOf(fn: AdapterCtx['fetch'], saved: { creds?: Creds, exp?: string | null }[] = []): AdapterCtx {
  return { fetch: fn, sleep: async () => {}, saveCreds: async (c, exp) => {
    saved.push({ creds: c, exp })
  } }
}

function graph(url: string, method: string): unknown {
  if (method === 'POST' && url.endsWith('/1789/media')) return { id: 'cont1' }
  if (url.includes('/cont1?')) return { status_code: 'FINISHED' }
  if (method === 'POST' && url.endsWith('/1789/media_publish')) return { id: 'm99' }
  if (url.includes('/m99?') && url.includes('permalink')) return { permalink: 'https://www.instagram.com/p/abc/' }
  return undefined
}

describe('Instagram mit Instagram-Login', () => {
  it('Anmelde-Adresse auf instagram.com mit den Business-Rechten', () => {
    const u = new URL(authorizeUrl('instagram', app, 's1'))
    expect(u.origin + u.pathname).toBe('https://www.instagram.com/oauth/authorize')
    expect(u.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights')
    expect(u.searchParams.get('redirect_uri')).toBe(app.redirectUri)
    expect(u.searchParams.get('state')).toBe('s1')
    expect(u.searchParams.get('response_type')).toBe('code')
  })

  it('OAuth-Tausch: kurzlebig gegen langlebig, Konto mit ID und Benutzername', async () => {
    const { fn, calls } = mockFetch((url, method) => {
      if (method === 'POST' && url === 'https://api.instagram.com/oauth/access_token') return { data: [{ access_token: 'short', user_id: '1789', permissions: 'instagram_business_basic' }] }
      if (url.startsWith('https://graph.instagram.com/access_token?')) return { access_token: 'IGAAlong', token_type: 'bearer', expires_in: 5_184_000 }
      if (url.includes('/me?')) return { user_id: '1789', username: 'thewandereraiband', account_type: 'MEDIA_CREATOR' }
      return undefined
    })
    const [r] = await instagramExchange(app, 'AQcode#_', fn)
    expect(calls[0]!.body).toMatchObject({ client_id: '123', client_secret: 'geheim', grant_type: 'authorization_code', redirect_uri: app.redirectUri, code: 'AQcode' })
    const long = new URL(calls[1]!.url)
    expect(long.searchParams.get('grant_type')).toBe('ig_exchange_token')
    expect(long.searchParams.get('access_token')).toBe('short')
    expect(r!.conn).toMatchObject({ provider: 'instagram', platform: 'instagram', name: '@thewandereraiband', handle: 'thewandereraiband', ext: { igUserId: '1789' } })
    expect(r!.creds.accessToken).toBe('IGAAlong')
    const days = (Date.parse(r!.expiresAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(59)
    expect(days).toBeLessThan(61)
  })

  it('OAuth-Fehler von Instagram wird lesbar', async () => {
    const { fn } = mockFetch(() => new Response(JSON.stringify({ error_type: 'OAuthException', code: 400, error_message: 'Invalid redirect_uri' }), { status: 400 }))
    await expect(instagramExchange(app, 'x', fn)).rejects.toThrow(/Instagram: HTTP 400: Invalid redirect_uri/)
  })

  it('Bild veröffentlichen: Container, Status, media_publish', async () => {
    const { fn, calls } = mockFetch(graph)
    const r = await instagramAdapter.post(conn, creds, { text: 'Neuer Song #indie', media: [jpg], link: null }, ctxOf(fn))
    expect(r).toMatchObject({ platform: 'instagram', ok: true, postId: 'm99', url: 'https://www.instagram.com/p/abc/' })
    expect(calls[0]!.url).toBe('https://graph.instagram.com/v25.0/1789/media')
    expect(calls[0]!.body).toMatchObject({ image_url: jpg.url, caption: 'Neuer Song #indie', access_token: 'IGAAlong' })
    expect(calls[2]!.url).toBe('https://graph.instagram.com/v25.0/1789/media_publish')
    expect(calls[2]!.body).toMatchObject({ creation_id: 'cont1' })
  })

  it('Reel und Karussell', async () => {
    const reel = mockFetch(graph)
    await instagramAdapter.post(conn, creds, { text: 'Reel', media: [{ name: 'v.mp4', mime: 'video/mp4', data: new Uint8Array(1), url: 'https://aimarage.com/m/v.mp4' }], link: null }, ctxOf(reel.fn))
    expect(reel.calls[0]!.body).toMatchObject({ media_type: 'REELS', video_url: 'https://aimarage.com/m/v.mp4', caption: 'Reel' })
    let n = 0
    const car = mockFetch((url, method) => {
      if (method === 'POST' && url.endsWith('/1789/media')) return { id: `k${++n}` }
      if (/\/k\d\?/.test(url)) return { status_code: 'FINISHED' }
      if (method === 'POST' && url.endsWith('/media_publish')) return { id: 'm1' }
      return { permalink: null }
    })
    await instagramAdapter.post(conn, creds, { text: 'Zwei', media: [jpg, { ...jpg, url: 'https://aimarage.com/m/t2.jpg' }], link: null }, ctxOf(car.fn))
    const posts = car.calls.filter(c => c.method === 'POST')
    expect(posts[0]!.body).toMatchObject({ image_url: jpg.url, is_carousel_item: 'true' })
    expect(posts[2]!.body).toMatchObject({ media_type: 'CAROUSEL', children: 'k1,k2', caption: 'Zwei' })
    expect(posts[3]!.body).toMatchObject({ creation_id: 'k3' })
  })

  it('fehlendes Bild, nicht öffentliche Datei, falsches Format', async () => {
    const { fn, calls } = mockFetch(graph)
    await expect(instagramAdapter.post(conn, creds, { text: 'Nur Text', media: [], link: null }, ctxOf(fn))).rejects.toThrow(/Bild oder Video nötig/)
    await expect(instagramAdapter.post(conn, creds, { text: 'x', media: [{ ...jpg, url: null }], link: null }, ctxOf(fn))).rejects.toThrow(PUBLIC_MEDIA_HINT)
    await expect(instagramAdapter.post(conn, creds, { text: 'x', media: [{ ...jpg, mime: 'image/png' }], link: null }, ctxOf(fn))).rejects.toThrow(/nur JPG/)
    expect(calls).toHaveLength(0)
    expect(postIssues('instagram', 'Nur Text', [])).toEqual(['image_needed'])
  })

  it('Download-Fehler von Instagram bekommt den Hinweis auf öffentliche Medien', async () => {
    const { fn } = mockFetch(() => new Response(JSON.stringify({ error: { message: 'Media download has failed. The media URI doesn\'t meet our requirements.' } }), { status: 400 }))
    await expect(instagramAdapter.post(conn, creds, { text: 'x', media: [jpg], link: null }, ctxOf(fn))).rejects.toThrow(/öffentlich erreichbar/)
  })

  it('Zahlen aus den Insights, sonst Likes und Kommentare', async () => {
    const ok = mockFetch(() => ({ data: [{ name: 'reach', values: [{ value: 40 }] }, { name: 'likes', values: [{ value: 7 }] }, { name: 'comments', values: [{ value: 2 }] }, { name: 'saved', values: [{ value: 1 }] }] }))
    expect(await instagramAdapter.stats!(conn, creds, { postId: 'm99', url: null }, ctxOf(ok.fn))).toEqual({ reach: 40, likes: 7, comments: 2, shares: 0, saves: 1 })
    const fallback = mockFetch(url => (url.includes('/insights') ? new Response('{}', { status: 403 }) : { like_count: 3, comments_count: 1 }))
    expect(await instagramAdapter.stats!(conn, creds, { postId: 'm99', url: null }, ctxOf(fallback.fn))).toEqual({ likes: 3, comments: 1 })
  })

  it('Token-Erneuerung: erst nach 24 Stunden, vor Ablauf, neuer Ablauf gespeichert', async () => {
    const now = Date.now()
    const day = 86_400_000
    expect(needsRefresh({ issuedAt: new Date(now - 3600_000).toISOString() }, new Date(now + 10 * day).toISOString(), now)).toBe(false)
    expect(needsRefresh({ issuedAt: new Date(now - 35 * day).toISOString() }, new Date(now + 25 * day).toISOString(), now)).toBe(true)
    expect(needsRefresh({ issuedAt: new Date(now - 5 * day).toISOString() }, new Date(now + 55 * day).toISOString(), now)).toBe(false)
    expect(needsRefresh({ issuedAt: new Date(now - 70 * day).toISOString() }, new Date(now - day).toISOString(), now)).toBe(false)
    const { fn, calls } = mockFetch(url => (url.startsWith('https://graph.instagram.com/refresh_access_token?') ? { access_token: 'IGAAneu', expires_in: 5_184_000 } : undefined))
    const saved: { creds?: Creds, exp?: string | null }[] = []
    const old = { ...conn, expiresAt: new Date(now + 20 * day).toISOString() }
    expect(await instagramAdapter.refresh!(old, { accessToken: 'IGAAalt', issuedAt: new Date(now - 40 * day).toISOString() }, ctxOf(fn, saved))).toBe(true)
    expect(new URL(calls[0]!.url).searchParams.get('grant_type')).toBe('ig_refresh_token')
    expect(saved[0]!.creds!.accessToken).toBe('IGAAneu')
    expect(Date.parse(saved[0]!.exp!) - now).toBeGreaterThan(59 * day)
  })
})

describe('Öffentliche Medien-Links', () => {
  beforeAll(() => {
    process.env.APP_SECRET = 'test-secret'
    resetSecretCache()
  })
  it('lokale Adressen sind nicht öffentlich', () => {
    for (const u of ['http://localhost:3210', 'http://127.0.0.1:3210', 'http://192.168.1.5', 'http://mac.local', 'http://[::1]:3210', 'http://intranet']) expect(isPublicBase(u)).toBe(false)
    expect(isPublicBase('https://aimarage.com')).toBe(true)
  })
  it('signierter Link mit Ablauf', () => {
    const link = mediaLink({ file: 'w/d/x.jpg', mime: 'image/jpeg' }, 'https://aimarage.com', Date.now())
    expect(link).toMatch(/^https:\/\/aimarage\.com\/m\/v1\.[\w-]+\.jpg$/)
    const name = link.split('/m/')[1]!
    expect(openMediaLink(name)).toEqual({ file: 'w/d/x.jpg', mime: 'image/jpeg' })
    expect(openMediaLink(name, Date.now() + 3 * 86_400_000)).toBeNull()
    expect(openMediaLink(`${name.slice(0, -8)}AAAA.jpg`)).toBeNull()
  })
})

describe('Tägliche Erneuerung', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  beforeAll(async () => {
    process.env.APP_SECRET = 'test-secret'
    resetSecretCache()
    ;({ db, close } = await openTestDb())
    ;[ws] = await db.insert(schema.workspaces).values({ name: 'Test' }).returning() as [typeof ws]
  })
  afterAll(async () => {
    delete process.env.APP_SECRET
    resetSecretCache()
    await close()
  })
  it('erneuert bald ablaufende Instagram-Zugänge und markiert abgelaufene', async () => {
    const day = 86_400_000
    await upsertConnection(db, ws.id, { provider: 'instagram', platform: 'instagram', name: '@a', handle: 'a', ext: { igUserId: '1' }, expiresAt: new Date(Date.now() + 10 * day).toISOString() }, { accessToken: 'alt', issuedAt: new Date(Date.now() - 50 * day).toISOString() })
    await upsertConnection(db, ws.id, { provider: 'instagram', platform: 'instagram', name: '@b', handle: 'b', ext: { igUserId: '2' }, expiresAt: new Date(Date.now() - day).toISOString() }, { accessToken: 'tot', issuedAt: new Date(Date.now() - 61 * day).toISOString() })
    ws = (await db.select().from(schema.workspaces))[0]!
    const { fn, calls } = mockFetch(() => ({ access_token: 'neu', expires_in: 5_184_000 }))
    const r = await refreshTokens(db, ws, fn)
    expect(r).toEqual({ refreshed: ['@a'], errors: [] })
    expect(calls).toHaveLength(1)
    ws = (await db.select().from(schema.workspaces))[0]!
    const [a, b] = listConnections(ws)
    expect(openCreds(ws.id, a!)!.accessToken).toBe('neu')
    expect(Date.parse(a!.expiresAt!) - Date.now()).toBeGreaterThan(59 * day)
    expect(b!.error).toMatch(/abgelaufen/)
  })
})
