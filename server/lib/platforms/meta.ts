import type { PostPlatformResult } from '../../db/schema'
import { isVertical, videoInfo } from '../mp4'
import type { FetchLike, OutletMedia } from '../outlets'
import { callJson, errText, firstUrl, form, jsonOf, PlatformError, timeoutSignal, type Creds, type PlatformAdapter, type SocialConn, wait } from './types'

export const GRAPH_VERSION = 'v25.0'
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`
export const META_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'business_management']

type Json = Record<string, unknown>

export function metaAuthorizeUrl(app: { clientId: string, redirectUri: string }, state: string): string {
  const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: app.redirectUri, state, response_type: 'code', scope: META_SCOPES.join(',') })
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${q}`
}

export async function metaExchange(app: { clientId: string, clientSecret: string, redirectUri: string }, code: string, f: FetchLike): Promise<{ conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds }[]> {
  const short = await callJson(f, 'Meta', `${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: app.clientId, redirect_uri: app.redirectUri, client_secret: app.clientSecret, code })}`)
  const long = await callJson(f, 'Meta', `${GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: String(short.access_token) })}`)
  const pages = await callJson(f, 'Meta', `${GRAPH}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: String(long.access_token) })}`)
  const list = (Array.isArray(pages.data) ? pages.data : []) as Json[]
  if (!list.length) throw new PlatformError('Meta: Keine Facebook-Seite gefunden. Instagram braucht ein Business- oder Creator-Konto, das mit einer Facebook-Seite verknüpft ist, und beim Verbinden müssen die Seiten angehakt sein.')
  const out: { conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds }[] = []
  for (const p of list) {
    const token = String(p.access_token)
    const pageId = String(p.id)
    out.push({ conn: { provider: 'meta', platform: 'facebook', name: String(p.name), handle: pageId, ext: { pageId } }, creds: { accessToken: token } })
    const ig = p.instagram_business_account as Json | undefined
    if (ig?.id) out.push({ conn: { provider: 'meta', platform: 'instagram', name: `@${String(ig.username ?? ig.id)}`, handle: String(ig.username ?? ig.id), ext: { igUserId: String(ig.id), pageId } }, creds: { accessToken: token } })
  }
  return out
}

async function hostOnPage(pageId: string, token: string, m: OutletMedia, f: FetchLike): Promise<string> {
  const fd = new FormData()
  fd.append('source', new Blob([m.data as unknown as ArrayBuffer], { type: m.mime }), m.name)
  fd.append('published', 'false')
  fd.append('access_token', token)
  const up = await callJson(f, 'Facebook', `${GRAPH}/${pageId}/photos`, { method: 'POST', body: fd }, 120_000)
  const info = await callJson(f, 'Facebook', `${GRAPH}/${String(up.id)}?${new URLSearchParams({ fields: 'images', access_token: token })}`)
  const imgs = (Array.isArray(info.images) ? info.images : []) as Json[]
  const src = imgs.map(i => String(i.source ?? '')).find(Boolean)
  if (!src) throw new PlatformError('Instagram: Bild konnte nicht über die Facebook-Seite bereitgestellt werden')
  return src
}

export async function publicImageUrl(pageId: string | undefined, token: string, m: OutletMedia, f: FetchLike): Promise<string> {
  if (!pageId) throw new PlatformError('Bild braucht eine verbundene Facebook-Seite (dient als Bildablage)')
  return hostOnPage(pageId, token, m, f)
}

async function permalink(id: string, token: string, field: string, f: FetchLike): Promise<string | null> {
  try {
    const d = await callJson(f, 'Meta', `${GRAPH}/${id}?${new URLSearchParams({ fields: field, access_token: token })}`)
    return typeof d[field] === 'string' ? String(d[field]) : null
  }
  catch {
    return null
  }
}

function insightValues(d: Json): Record<string, number> {
  const out: Record<string, number> = {}
  for (const x of (Array.isArray(d.data) ? d.data : []) as Json[]) {
    const v = (Array.isArray(x.values) ? (x.values[0] as Json)?.value : (x.total_value as Json)?.value) as unknown
    if (typeof v === 'number') out[String(x.name)] = v
  }
  return out
}

export const MAX_FB_REEL_S = 90
const RUPLOAD = 'https://rupload.facebook.com'

async function rupload(f: FetchLike, label: string, url: string, token: string, m: OutletMedia): Promise<void> {
  const res = await f(url, { method: 'POST', headers: { 'Authorization': `OAuth ${token}`, 'offset': '0', 'file_size': String(m.data.byteLength), 'Content-Type': 'application/octet-stream' }, body: m.data as unknown as BodyInit, signal: timeoutSignal(600_000) }).catch((err: Error) => {
    throw new PlatformError(`${label}: Video-Upload nicht erreichbar (${err.message.slice(0, 120)})`)
  })
  const data = await jsonOf(res)
  if (!res.ok || data.success === false) {
    const dbg = data.debug_info as Json | undefined
    throw new PlatformError(`${label}: Video-Upload fehlgeschlagen (${typeof dbg?.message === 'string' ? dbg.message.slice(0, 200) : errText(data, res.status)})`, res.status)
  }
}

export function checkFacebookMedia(media: OutletMedia[]): void {
  const videos = media.filter(m => m.mime.startsWith('video/'))
  if (videos.length && media.length > 1) throw new PlatformError('Facebook: Video nur allein, ohne weitere Bilder oder Videos')
  if (media.length > 10) throw new PlatformError('Facebook: höchstens 10 Bilder je Beitrag')
  const v = videos[0]
  if (v) {
    const info = videoInfo(v.data)
    if (isVertical(info) === false) throw new PlatformError('Facebook: Videos gehen als Reel und müssen hochkant sein (9:16)')
    if (info.seconds !== null && (info.seconds < 3 || info.seconds > MAX_FB_REEL_S)) throw new PlatformError(`Facebook: Reels müssen 3 bis ${MAX_FB_REEL_S} Sekunden lang sein (Video: ${Math.round(info.seconds)} s)`)
  }
}

export function checkMetaInstagramMedia(media: OutletMedia[]): void {
  if (!media.length) throw new PlatformError('Instagram: Bild oder Video nötig')
  if (media.length > 10) throw new PlatformError('Instagram: höchstens 10 Bilder oder Videos (Karussell)')
  for (const m of media) {
    if (m.mime.startsWith('image/') && m.mime !== 'image/jpeg') throw new PlatformError('Instagram: nur JPG-Bilder')
    if (!m.mime.startsWith('image/') && !m.mime.startsWith('video/')) throw new PlatformError('Instagram: nur Bilder oder Videos')
  }
}

async function facebookPost(pageId: string, token: string, req: Parameters<PlatformAdapter['post']>[2], f: FetchLike, ctx: Parameters<PlatformAdapter['post']>[3]): Promise<PostPlatformResult> {
  checkFacebookMedia(req.media)
  const video = req.media.find(m => m.mime.startsWith('video/'))
  if (video) {
    const start = await callJson(f, 'Facebook', `${GRAPH}/${pageId}/video_reels`, { method: 'POST', body: form({ upload_phase: 'start', access_token: token }) })
    const videoId = String(start.video_id ?? '')
    if (!videoId) throw new PlatformError('Facebook: Reel konnte nicht angelegt werden')
    await rupload(f, 'Facebook', typeof start.upload_url === 'string' ? start.upload_url : `${RUPLOAD}/video-upload/${GRAPH_VERSION}/${videoId}`, token, video)
    await callJson(f, 'Facebook', `${GRAPH}/${pageId}/video_reels`, { method: 'POST', body: form({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: req.text, access_token: token }) }, 60_000)
    for (let i = 0; i < 30; i++) {
      const st = await callJson(f, 'Facebook', `${GRAPH}/${videoId}?${new URLSearchParams({ fields: 'status', access_token: token })}`)
      const status = (st.status ?? {}) as Json
      const vs = String(status.video_status ?? '')
      const pub = String(((status.publishing_phase ?? {}) as Json).status ?? '')
      if (vs === 'error' || vs === 'upload_failed' || vs === 'expired') {
        const e = ((status.processing_phase ?? {}) as Json).errors
        throw new PlatformError(`Facebook: Reel abgelehnt (${vs}${Array.isArray(e) && e[0] ? `: ${String((e[0] as Json).message ?? '').slice(0, 200)}` : ''})`)
      }
      if (vs === 'ready' || pub === 'complete') break
      await wait(ctx, 10_000)
    }
    return { platform: 'facebook', ok: true, postId: `reel:${videoId}`, url: await permalink(videoId, token, 'permalink_url', f).then(u => (u && u.startsWith('/') ? `https://www.facebook.com${u}` : u)) }
  }
  const images = req.media.filter(m => m.mime.startsWith('image/'))
  if (images.length === 1) {
    const img = images[0]!
    const fd = new FormData()
    fd.append('source', new Blob([img.data as unknown as ArrayBuffer], { type: img.mime }), img.name)
    fd.append('caption', req.text)
    fd.append('access_token', token)
    const d = await callJson(f, 'Facebook', `${GRAPH}/${pageId}/photos`, { method: 'POST', body: fd }, 120_000)
    const postId = String(d.post_id ?? d.id)
    return { platform: 'facebook', ok: true, postId, url: await permalink(postId, token, 'permalink_url', f) }
  }
  if (images.length > 1) {
    const ids: string[] = []
    for (const img of images) {
      const fd = new FormData()
      fd.append('source', new Blob([img.data as unknown as ArrayBuffer], { type: img.mime }), img.name)
      fd.append('published', 'false')
      fd.append('access_token', token)
      const up = await callJson(f, 'Facebook', `${GRAPH}/${pageId}/photos`, { method: 'POST', body: fd }, 120_000)
      ids.push(String(up.id))
    }
    const params: Record<string, string> = { message: req.text, access_token: token }
    ids.forEach((id, i) => {
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })
    })
    const d = await callJson(f, 'Facebook', `${GRAPH}/${pageId}/feed`, { method: 'POST', body: form(params) }, 60_000)
    const postId = String(d.id)
    return { platform: 'facebook', ok: true, postId, url: await permalink(postId, token, 'permalink_url', f) }
  }
  const link = req.link ?? firstUrl(req.text)
  const d = await callJson(f, 'Facebook', `${GRAPH}/${pageId}/feed`, { method: 'POST', body: form({ message: req.text, ...(link ? { link } : {}), access_token: token }) })
  const postId = String(d.id)
  return { platform: 'facebook', ok: true, postId, url: await permalink(postId, token, 'permalink_url', f) }
}

async function instagramPost(conn: SocialConn, token: string, req: Parameters<PlatformAdapter['post']>[2], f: FetchLike, ctx: Parameters<PlatformAdapter['post']>[3]): Promise<PostPlatformResult> {
  checkMetaInstagramMedia(req.media)
  const ig = conn.ext!.igUserId!
  const create = async (params: Record<string, string>): Promise<Json> => callJson(f, 'Instagram', `${GRAPH}/${ig}/media`, { method: 'POST', body: form({ ...params, access_token: token }) }, 60_000)
  const ready = async (id: string, video: boolean): Promise<void> => {
    const tries = video ? 30 : 10
    for (let i = 0; i < tries; i++) {
      const st = await callJson(f, 'Instagram', `${GRAPH}/${id}?${new URLSearchParams({ fields: 'status_code,status', access_token: token })}`)
      if (st.status_code === 'FINISHED' || st.status_code === 'PUBLISHED') return
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new PlatformError(`Instagram: Datei abgelehnt (${String(st.status_code)}${typeof st.status === 'string' && st.status ? `: ${st.status.slice(0, 200)}` : ''})`)
      await wait(ctx, video ? 10_000 : 3000)
    }
    throw new PlatformError('Instagram: Verarbeitung dauert zu lange, bitte später erneut versuchen')
  }
  const container = async (m: OutletMedia, extra: Record<string, string>, carousel: boolean): Promise<string> => {
    if (m.mime.startsWith('video/')) {
      const c = await create({ media_type: carousel ? 'VIDEO' : 'REELS', upload_type: 'resumable', ...extra })
      const id = String(c.id)
      await rupload(f, 'Instagram', typeof c.uri === 'string' ? c.uri : `${RUPLOAD}/ig-api-upload/${GRAPH_VERSION}/${id}`, token, m)
      await ready(id, true)
      return id
    }
    const imageUrl = m.url || await publicImageUrl(conn.ext?.pageId, token, m, f)
    const id = String((await create({ image_url: imageUrl, ...extra })).id)
    await ready(id, false)
    return id
  }
  let creation: string
  if (req.media.length === 1) {
    creation = await container(req.media[0]!, { caption: req.text }, false)
  }
  else {
    const children: string[] = []
    for (const m of req.media) children.push(await container(m, { is_carousel_item: 'true' }, true))
    creation = String((await create({ media_type: 'CAROUSEL', children: children.join(','), caption: req.text })).id)
    await ready(creation, false)
  }
  const p = await callJson(f, 'Instagram', `${GRAPH}/${ig}/media_publish`, { method: 'POST', body: form({ creation_id: creation, access_token: token }) }, 60_000)
  const id = String(p.id)
  return { platform: 'instagram', ok: true, postId: id, url: await permalink(id, token, 'permalink', f) }
}

export const metaAdapter: PlatformAdapter = {
  provider: 'meta',
  label: 'Meta',
  platforms: ['facebook', 'instagram'],
  async post(conn, creds, req, ctx) {
    const token = creds.accessToken!
    if (conn.platform === 'facebook') return facebookPost(conn.ext!.pageId!, token, req, ctx.fetch, ctx)
    return instagramPost(conn, token, req, ctx.fetch, ctx)
  },
  async stats(conn, creds, ref, ctx): Promise<Record<string, number>> {
    if (!ref.postId) return {}
    const token = creds.accessToken!
    if (conn.platform === 'instagram') {
      const v = insightValues(await callJson(ctx.fetch, 'Instagram', `${GRAPH}/${ref.postId}/insights?${new URLSearchParams({ metric: 'views,reach,likes,comments,shares,saved', access_token: token })}`))
      return { reach: v.reach ?? v.views ?? 0, likes: v.likes ?? 0, comments: v.comments ?? 0, shares: v.shares ?? 0, saves: v.saved ?? 0 }
    }
    if (ref.postId.startsWith('reel:')) {
      const vid = ref.postId.slice(5)
      const d = await callJson(ctx.fetch, 'Facebook', `${GRAPH}/${vid}?${new URLSearchParams({ fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0)', access_token: token })}`)
      const out: Record<string, number> = { likes: Number(((d.likes as Json)?.summary as Json)?.total_count ?? 0), comments: Number(((d.comments as Json)?.summary as Json)?.total_count ?? 0) }
      try {
        const v = insightValues(await callJson(ctx.fetch, 'Facebook', `${GRAPH}/${vid}/video_insights?${new URLSearchParams({ metric: 'blue_reels_play_count', access_token: token })}`))
        if (v.blue_reels_play_count !== undefined) out.views = v.blue_reels_play_count
      }
      catch {
        return out
      }
      return out
    }
    const d = await callJson(ctx.fetch, 'Facebook', `${GRAPH}/${ref.postId}?${new URLSearchParams({ fields: 'shares,reactions.summary(total_count),comments.summary(total_count)', access_token: token })}`)
    const out: Record<string, number> = {
      likes: Number(((d.reactions as Json)?.summary as Json)?.total_count ?? 0),
      comments: Number(((d.comments as Json)?.summary as Json)?.total_count ?? 0),
      shares: Number((d.shares as Json)?.count ?? 0),
    }
    try {
      const v = insightValues(await callJson(ctx.fetch, 'Facebook', `${GRAPH}/${ref.postId}/insights?${new URLSearchParams({ metric: 'post_total_media_view_unique,post_clicks', access_token: token })}`))
      if (v.post_total_media_view_unique !== undefined) out.reach = v.post_total_media_view_unique
      if (v.post_clicks !== undefined) out.clicks = v.post_clicks
    }
    catch {
      return out
    }
    return out
  },
  async followers(conn, creds, ctx) {
    const token = creds.accessToken!
    const id = conn.platform === 'instagram' ? conn.ext?.igUserId : conn.ext?.pageId
    if (!id) return null
    const d = await callJson(ctx.fetch, 'Meta', `${GRAPH}/${id}?${new URLSearchParams({ fields: 'followers_count', access_token: token })}`)
    return typeof d.followers_count === 'number' ? d.followers_count : null
  },
}

export async function verifyMeta(conn: SocialConn, creds: Creds, f: FetchLike): Promise<string> {
  const id = conn.platform === 'instagram' ? conn.ext?.igUserId : conn.ext?.pageId
  const d = await callJson(f, conn.platform === 'instagram' ? 'Instagram' : 'Facebook', `${GRAPH}/${id}?${new URLSearchParams({ fields: conn.platform === 'instagram' ? 'username' : 'name', access_token: creds.accessToken! })}`)
  return conn.platform === 'instagram' ? `@${String(d.username)}` : String(d.name)
}
