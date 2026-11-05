import { describe, expect, it } from 'vitest'
import { threadsAdapter, THREADS_MEDIA_HINT } from '../../server/lib/platforms/threads'
import type { AdapterCtx, Creds, SocialConn } from '../../server/lib/platforms/types'

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

const ctxOf = (fn: AdapterCtx['fetch']): AdapterCtx => ({ fetch: fn, sleep: async () => {}, saveCreds: async () => {} })
const conn: SocialConn = { id: 't1', provider: 'threads', platform: 'threads', name: '@tv', handle: 'tv', ext: { userId: '42' }, secret: { enc: '', hint: '', setAt: '' } }
const creds: Creds = { accessToken: 'THTOKEN', issuedAt: new Date().toISOString() }
const img = (n: number, mime = 'image/jpeg') => ({ name: `b${n}.jpg`, mime, data: new Uint8Array([n]), url: `https://aimarage.com/m/b${n}.jpg` })
const vid = { name: 'v.mp4', mime: 'video/mp4', data: new Uint8Array([1]), url: 'https://aimarage.com/m/v.mp4' }

function api(statusOf: (id: string) => Record<string, unknown> = () => ({ status: 'FINISHED' })) {
  let n = 0
  return (url: string, method: string): unknown => {
    if (method === 'POST' && url.endsWith('/42/threads')) return { id: `c${++n}` }
    if (method === 'POST' && url.endsWith('/42/threads_publish')) return { id: 'p9' }
    if (url.includes('/p9?')) return { permalink: 'https://www.threads.net/@tv/post/abc' }
    const m = /\/(c\d+)\?/.exec(url)
    if (m) return statusOf(m[1]!)
    return undefined
  }
}

describe('Threads mit Bildern', () => {
  it('nur Text wie bisher, mit Link-Vorschau', async () => {
    const { fn, calls } = mockFetch(api())
    const r = await threadsAdapter.post(conn, creds, { text: 'Hallo https://thewanderer.ai', media: [], link: null }, ctxOf(fn))
    expect(r).toMatchObject({ platform: 'threads', ok: true, postId: 'p9', url: 'https://www.threads.net/@tv/post/abc' })
    expect(calls[0]!.body).toMatchObject({ media_type: 'TEXT', text: 'Hallo https://thewanderer.ai', link_attachment: 'https://thewanderer.ai' })
  })

  it('ein Bild: IMAGE-Container, Status abwarten, veröffentlichen', async () => {
    const { fn, calls } = mockFetch(api())
    await threadsAdapter.post(conn, creds, { text: 'Neues Cover', media: [img(1)], link: null }, ctxOf(fn))
    expect(calls[0]!.url).toBe('https://graph.threads.net/v1.0/42/threads')
    expect(calls[0]!.body).toMatchObject({ media_type: 'IMAGE', image_url: 'https://aimarage.com/m/b1.jpg', text: 'Neues Cover', access_token: 'THTOKEN' })
    expect(calls[0]!.body.link_attachment).toBeUndefined()
    expect(calls[1]!.url).toContain('/c1?fields=status%2Cerror_message')
    expect(calls[2]!.body).toMatchObject({ creation_id: 'c1' })
  })

  it('Video als VIDEO-Container', async () => {
    const { fn, calls } = mockFetch(api())
    await threadsAdapter.post(conn, creds, { text: 'Clip', media: [vid], link: null }, ctxOf(fn))
    expect(calls[0]!.body).toMatchObject({ media_type: 'VIDEO', video_url: 'https://aimarage.com/m/v.mp4', text: 'Clip' })
  })

  it('Karussell aus Bild, PNG und Video', async () => {
    const { fn, calls } = mockFetch(api())
    await threadsAdapter.post(conn, creds, { text: 'Drei', media: [img(1), img(2, 'image/png'), vid], link: null }, ctxOf(fn))
    const posts = calls.filter(c => c.method === 'POST')
    expect(posts[0]!.body).toMatchObject({ media_type: 'IMAGE', is_carousel_item: 'true' })
    expect(posts[0]!.body.text).toBeUndefined()
    expect(posts[2]!.body).toMatchObject({ media_type: 'VIDEO', is_carousel_item: 'true' })
    expect(posts[3]!.body).toMatchObject({ media_type: 'CAROUSEL', children: 'c1,c2,c3', text: 'Drei' })
    expect(posts[4]!.body).toMatchObject({ creation_id: 'c4' })
  })

  it('Fehlerfälle: lokale Datei, WebP, zu viele, abgelehnte Datei', async () => {
    const { fn, calls } = mockFetch(api())
    await expect(threadsAdapter.post(conn, creds, { text: 'x', media: [{ ...img(1), url: null }], link: null }, ctxOf(fn))).rejects.toThrow(THREADS_MEDIA_HINT)
    await expect(threadsAdapter.post(conn, creds, { text: 'x', media: [img(1, 'image/webp')], link: null }, ctxOf(fn))).rejects.toThrow(/nur JPG- oder PNG/)
    await expect(threadsAdapter.post(conn, creds, { text: 'x', media: Array.from({ length: 21 }, (_, i) => img(i)), link: null }, ctxOf(fn))).rejects.toThrow(/höchstens 20/)
    expect(calls).toHaveLength(0)
    const bad = mockFetch(api(() => ({ status: 'ERROR', error_message: 'Bild zu klein' })))
    await expect(threadsAdapter.post(conn, creds, { text: 'x', media: [img(1)], link: null }, ctxOf(bad.fn))).rejects.toThrow(/Datei abgelehnt \(ERROR: Bild zu klein\)/)
    const nodl = mockFetch(() => new Response(JSON.stringify({ error: { message: 'Media download has failed' } }), { status: 400 }))
    await expect(threadsAdapter.post(conn, creds, { text: 'x', media: [img(1)], link: null }, ctxOf(nodl.fn))).rejects.toThrow(/öffentlich erreichbar/)
  })
})
