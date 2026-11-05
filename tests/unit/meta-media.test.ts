import { describe, expect, it } from 'vitest'
import { isVertical, videoInfo } from '../../server/lib/mp4'
import { metaAdapter } from '../../server/lib/platforms/meta'
import type { AdapterCtx, Creds, SocialConn } from '../../server/lib/platforms/types'
import { postIssues } from '../../shared/utils/social'
import { fakeMp4 } from './fixtures/mp4'

type Call = { url: string, method: string, body: Record<string, string>, headers: Record<string, string>, size: number }

function mockFetch(handler: (url: string, method: string) => unknown) {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    const method = String(init.method ?? 'GET')
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<${v.type}>`])) : {}
    calls.push({ url, method, body, headers: (init.headers ?? {}) as Record<string, string>, size: init.body instanceof Uint8Array ? init.body.byteLength : 0 })
    const d = handler(url, method)
    if (d instanceof Response) return d
    return new Response(JSON.stringify(d ?? {}), { status: d === undefined ? 404 : 200, headers: { 'content-type': 'application/json' } })
  }
  return { fn, calls }
}

const ctxOf = (fn: AdapterCtx['fetch']): AdapterCtx => ({ fetch: fn, sleep: async () => {}, saveCreds: async () => {} })
const creds: Creds = { accessToken: 'PAGETOKEN' }
const fb: SocialConn = { id: 'f1', provider: 'meta', platform: 'facebook', name: 'The Wanderer', handle: '55', ext: { pageId: '55' }, secret: { enc: '', hint: '', setAt: '' } }
const ig: SocialConn = { id: 'i1', provider: 'meta', platform: 'instagram', name: '@tv', handle: 'tv', ext: { igUserId: '77', pageId: '55' }, secret: { enc: '', hint: '', setAt: '' } }
const jpg = (n: number) => ({ name: `b${n}.jpg`, mime: 'image/jpeg', data: new Uint8Array([0xFF, 0xD8, 0xFF, n]) })
const reel = { name: 'r.mp4', mime: 'video/mp4', data: fakeMp4({ seconds: 30, width: 1080, height: 1920 }) }
const wide = { name: 'w.mp4', mime: 'video/mp4', data: fakeMp4({ seconds: 30, width: 1920, height: 1080 }) }

describe('MP4-Kopf lesen', () => {
  it('Dauer und Format, gedrehtes Handy-Video zählt als hochkant', () => {
    expect(videoInfo(reel.data)).toEqual({ seconds: 30, width: 1080, height: 1920 })
    expect(isVertical(videoInfo(wide.data))).toBe(false)
    const turned = videoInfo(fakeMp4({ seconds: 12.5, width: 1920, height: 1080, rotate: true }))
    expect(turned).toEqual({ seconds: 12.5, width: 1080, height: 1920 })
    expect(videoInfo(new Uint8Array([1, 2, 3]))).toEqual({ seconds: null, width: null, height: null })
  })
})

describe('Prüfung je Plattform', () => {
  it('Instagram nur JPG und max. 10, Facebook Video nur allein, Threads max. 20, YouTube ein Video', () => {
    expect(postIssues('instagram', 'x', [{ mime: 'image/png' }])).toEqual(['media_format'])
    expect(postIssues('instagram', 'x', Array.from({ length: 11 }, () => ({ mime: 'image/jpeg' })))).toEqual(['too_many_media'])
    expect(postIssues('facebook', 'x', [{ mime: 'video/mp4' }, { mime: 'image/jpeg' }])).toEqual(['mixed_media'])
    expect(postIssues('facebook', 'x', [{ mime: 'image/png' }, { mime: 'image/jpeg' }])).toEqual([])
    expect(postIssues('threads', 'x', [{ mime: 'image/webp' }])).toEqual(['media_format'])
    expect(postIssues('youtube', 'x', [{ mime: 'video/mp4' }, { mime: 'video/mp4' }])).toEqual(['too_many_media'])
    expect(postIssues('youtube', 'x', [{ mime: 'video/mp4' }])).toEqual([])
  })
})

describe('Facebook-Seite: mehrere Bilder und Reels', () => {
  it('mehrere Bilder: unveröffentlicht hochladen, dann ein Beitrag mit attached_media', async () => {
    let n = 0
    const { fn, calls } = mockFetch((url, method) => {
      if (method === 'POST' && url.endsWith('/55/photos')) return { id: `ph${++n}` }
      if (method === 'POST' && url.endsWith('/55/feed')) return { id: '55_900' }
      if (url.includes('/55_900?')) return { permalink_url: 'https://www.facebook.com/55/posts/900' }
      return undefined
    })
    const r = await metaAdapter.post(fb, creds, { text: 'Drei Bilder', media: [jpg(1), jpg(2), jpg(3)], link: null }, ctxOf(fn))
    expect(r).toMatchObject({ platform: 'facebook', ok: true, postId: '55_900', url: 'https://www.facebook.com/55/posts/900' })
    const photos = calls.filter(c => c.url.endsWith('/55/photos'))
    expect(photos).toHaveLength(3)
    expect(photos[0]!.body).toMatchObject({ published: 'false', source: '<image/jpeg>' })
    const feed = calls.find(c => c.url.endsWith('/55/feed'))!
    expect(feed.body).toMatchObject({ 'message': 'Drei Bilder', 'attached_media[0]': '{"media_fbid":"ph1"}', 'attached_media[2]': '{"media_fbid":"ph3"}' })
  })

  it('Reel: Start, Upload an rupload, Abschluss, Status', async () => {
    const { fn, calls } = mockFetch((url, method) => {
      if (method === 'POST' && url.endsWith('/55/video_reels')) return calls.filter(c => c.url.endsWith('/55/video_reels')).length === 1 ? { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/v1' } : { success: true }
      if (url.startsWith('https://rupload.facebook.com/')) return { success: true }
      if (url.includes('/v1?') && url.includes('fields=status')) return { status: { video_status: 'ready' } }
      if (url.includes('/v1?') && url.includes('permalink_url')) return { permalink_url: '/reel/123' }
      return undefined
    })
    const r = await metaAdapter.post(fb, creds, { text: 'Neues Reel', media: [reel], link: null }, ctxOf(fn))
    expect(r).toMatchObject({ platform: 'facebook', ok: true, postId: 'reel:v1', url: 'https://www.facebook.com/reel/123' })
    expect(calls[0]!.body).toMatchObject({ upload_phase: 'start' })
    expect(calls[1]!.headers).toMatchObject({ Authorization: 'OAuth PAGETOKEN', offset: '0', file_size: String(reel.data.byteLength) })
    expect(calls[1]!.size).toBe(reel.data.byteLength)
    expect(calls[2]!.body).toMatchObject({ upload_phase: 'finish', video_id: 'v1', video_state: 'PUBLISHED', description: 'Neues Reel' })
  })

  it('Querformat, zu langes Video und Video mit Bild werden vorher abgelehnt', async () => {
    const { fn, calls } = mockFetch(() => ({}))
    await expect(metaAdapter.post(fb, creds, { text: 'x', media: [wide], link: null }, ctxOf(fn))).rejects.toThrow(/hochkant/)
    await expect(metaAdapter.post(fb, creds, { text: 'x', media: [{ ...reel, data: fakeMp4({ seconds: 200, width: 720, height: 1280 }) }], link: null }, ctxOf(fn))).rejects.toThrow(/3 bis 90 Sekunden/)
    await expect(metaAdapter.post(fb, creds, { text: 'x', media: [reel, jpg(1)], link: null }, ctxOf(fn))).rejects.toThrow(/nur allein/)
    expect(calls).toHaveLength(0)
  })

  it('Upload-Fehler von rupload wird lesbar', async () => {
    const { fn } = mockFetch((url) => {
      if (url.endsWith('/55/video_reels')) return { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/v1' }
      return new Response(JSON.stringify({ debug_info: { retriable: false, type: 'ProcessingFailedError', message: 'Request processing failed' } }), { status: 400 })
    })
    await expect(metaAdapter.post(fb, creds, { text: 'x', media: [reel], link: null }, ctxOf(fn))).rejects.toThrow(/Video-Upload fehlgeschlagen \(Request processing failed\)/)
  })
})

describe('Instagram über die Facebook-Seite: Karussell und Reel', () => {
  it('Reel per Resumable-Upload, ohne öffentliche Adresse', async () => {
    const { fn, calls } = mockFetch((url, method) => {
      if (method === 'POST' && url.endsWith('/77/media')) return { id: 'c1', uri: 'https://rupload.facebook.com/ig-api-upload/v25.0/c1' }
      if (url.startsWith('https://rupload.facebook.com/ig-api-upload/')) return { success: true, message: 'Upload successful.' }
      if (url.includes('/c1?')) return { status_code: 'FINISHED' }
      if (url.endsWith('/77/media_publish')) return { id: 'm5' }
      if (url.includes('/m5?')) return { permalink: 'https://www.instagram.com/reel/xyz/' }
      return undefined
    })
    const r = await metaAdapter.post(ig, creds, { text: 'Reel', media: [reel], link: null }, ctxOf(fn))
    expect(r).toMatchObject({ platform: 'instagram', ok: true, postId: 'm5', url: 'https://www.instagram.com/reel/xyz/' })
    expect(calls[0]!.body).toMatchObject({ media_type: 'REELS', upload_type: 'resumable', caption: 'Reel' })
    expect(calls[1]!.url).toBe('https://rupload.facebook.com/ig-api-upload/v25.0/c1')
    expect(calls[1]!.headers).toMatchObject({ offset: '0', file_size: String(reel.data.byteLength) })
  })

  it('Karussell aus Bild (über die Seite bereitgestellt) und Video', async () => {
    let n = 0
    const { fn, calls } = mockFetch((url, method) => {
      if (method === 'POST' && url.endsWith('/55/photos')) return { id: 'ph1' }
      if (url.includes('/ph1?')) return { images: [{ source: 'https://scontent.xx.fbcdn.net/b1.jpg' }] }
      if (method === 'POST' && url.endsWith('/77/media')) return { id: `k${++n}`, uri: `https://rupload.facebook.com/ig-api-upload/v25.0/k${n}` }
      if (url.startsWith('https://rupload.facebook.com/')) return { success: true }
      if (/\/k\d\?/.test(url)) return { status_code: 'FINISHED' }
      if (url.endsWith('/77/media_publish')) return { id: 'm6' }
      return { permalink: null }
    })
    await metaAdapter.post(ig, creds, { text: 'Zwei', media: [jpg(1), reel], link: null }, ctxOf(fn))
    const media = calls.filter(c => c.method === 'POST' && c.url.endsWith('/77/media'))
    expect(media[0]!.body).toMatchObject({ image_url: 'https://scontent.xx.fbcdn.net/b1.jpg', is_carousel_item: 'true' })
    expect(media[1]!.body).toMatchObject({ media_type: 'VIDEO', upload_type: 'resumable', is_carousel_item: 'true' })
    expect(media[2]!.body).toMatchObject({ media_type: 'CAROUSEL', children: 'k1,k2', caption: 'Zwei' })
    expect(calls.find(c => c.url.endsWith('/media_publish'))!.body).toMatchObject({ creation_id: 'k3' })
  })

  it('abgelehntes Video bricht ab, PNG wird vorher abgelehnt', async () => {
    const { fn } = mockFetch((url, method) => {
      if (method === 'POST' && url.endsWith('/77/media')) return { id: 'c1', uri: 'https://rupload.facebook.com/ig-api-upload/v25.0/c1' }
      if (url.startsWith('https://rupload.facebook.com/')) return { success: true }
      if (url.includes('/c1?')) return { status_code: 'ERROR', status: 'Video zu kurz' }
      return undefined
    })
    await expect(metaAdapter.post(ig, creds, { text: 'x', media: [reel], link: null }, ctxOf(fn))).rejects.toThrow(/Datei abgelehnt \(ERROR: Video zu kurz\)/)
    await expect(metaAdapter.post(ig, creds, { text: 'x', media: [{ ...jpg(1), mime: 'image/png' }], link: null }, ctxOf(fn))).rejects.toThrow(/nur JPG/)
  })

  it('Reel-Zahlen auf Facebook', async () => {
    const { fn } = mockFetch(url => (url.includes('/video_insights') ? { data: [{ name: 'blue_reels_play_count', values: [{ value: 321 }] }] } : { likes: { summary: { total_count: 9 } }, comments: { summary: { total_count: 2 } } }))
    expect(await metaAdapter.stats!(fb, creds, { postId: 'reel:v1', url: null }, ctxOf(fn))).toEqual({ likes: 9, comments: 2, views: 321 })
  })
})
