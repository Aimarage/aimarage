import type { FetchLike } from '../outlets'
import { callJson, form, PlatformError, timeoutSignal, type AdapterCtx, type Creds, type PlatformAdapter, type SocialConn, wait } from './types'

const API = 'https://open.tiktokapis.com'
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.publish', 'video.upload', 'video.list']
const CHUNK = 10 * 1024 * 1024
const SINGLE_MAX = 64 * 1024 * 1024

type Json = Record<string, unknown>

export function tiktokAuthorizeUrl(app: { clientId: string, redirectUri: string }, state: string): string {
  const q = new URLSearchParams({ client_key: app.clientId, response_type: 'code', scope: TIKTOK_SCOPES.join(','), redirect_uri: app.redirectUri, state })
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`
}

function tokenCreds(t: Json): { creds: Creds, expiresAt: string } {
  const now = Date.now()
  return {
    creds: { accessToken: String(t.access_token), refreshToken: String(t.refresh_token), openId: String(t.open_id), refreshExpiresAt: new Date(now + Number(t.refresh_expires_in ?? 31_536_000) * 1000).toISOString(), accessExpiresAt: new Date(now + Number(t.expires_in ?? 86_400) * 1000).toISOString() },
    expiresAt: new Date(now + Number(t.refresh_expires_in ?? 31_536_000) * 1000).toISOString(),
  }
}

async function tokenCall(f: FetchLike, params: Record<string, string>): Promise<Json> {
  const t = await callJson(f, 'TikTok', `${API}/v2/oauth/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(params) })
  if (t.error) throw new PlatformError(`TikTok: ${String(t.error_description ?? t.error)}`)
  return t
}

export async function tiktokExchange(app: { clientId: string, clientSecret: string, redirectUri: string }, code: string, f: FetchLike): Promise<{ conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds, expiresAt: string }[]> {
  const t = await tokenCall(f, { client_key: app.clientId, client_secret: app.clientSecret, code: decodeURIComponent(code), grant_type: 'authorization_code', redirect_uri: app.redirectUri })
  const { creds, expiresAt } = tokenCreds(t)
  const me = await callJson(f, 'TikTok', `${API}/v2/user/info/?fields=open_id,display_name,username`, { headers: { Authorization: `Bearer ${creds.accessToken}` } })
  const u = ((me.data as Json)?.user ?? {}) as Json
  const handle = String(u.username ?? u.display_name ?? creds.openId)
  return [{ conn: { provider: 'tiktok', platform: 'tiktok', name: `@${handle}`, handle, ext: { openId: creds.openId! }, expiresAt }, creds, expiresAt }]
}

async function accessToken(creds: Creds, ctx: AdapterCtx): Promise<string> {
  if (Date.parse(creds.accessExpiresAt ?? '') - Date.now() > 5 * 60_000) return creds.accessToken!
  if (!ctx.app) throw new PlatformError('TikTok: App-Schlüssel fehlen (Einstellungen > Plattform-Zugänge, /einstellungen/apps?app=tiktok)')
  if (Date.parse(creds.refreshExpiresAt ?? '') < Date.now()) throw new PlatformError('TikTok: Zugang abgelaufen, bitte neu verbinden')
  const t = await tokenCall(ctx.fetch, { client_key: ctx.app.clientId, client_secret: ctx.app.clientSecret, grant_type: 'refresh_token', refresh_token: creds.refreshToken! })
  const next = tokenCreds(t)
  await ctx.saveCreds(next.creds, next.expiresAt)
  return next.creds.accessToken!
}

function ttData(d: Json, label: string): Json {
  const err = d.error as Json | undefined
  if (err && err.code && err.code !== 'ok') throw new PlatformError(`TikTok ${label}: ${String(err.message || err.code)}`)
  return (d.data ?? {}) as Json
}

export function chunking(size: number): { chunkSize: number, count: number } {
  if (size <= SINGLE_MAX) return { chunkSize: size, count: 1 }
  return { chunkSize: CHUNK, count: Math.floor(size / CHUNK) }
}

export const tiktokAdapter: PlatformAdapter = {
  provider: 'tiktok',
  label: 'TikTok',
  platforms: ['tiktok'],
  async post(_conn, creds, req, ctx) {
    const video = req.media.find(m => m.mime.startsWith('video/'))
    if (!video) throw new PlatformError('TikTok: Video nötig (Fotos gehen nur über eine bestätigte Domain)')
    const token = await accessToken(creds, ctx)
    const h = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }
    const info = ttData(await callJson(ctx.fetch, 'TikTok', `${API}/v2/post/publish/creator_info/query/`, { method: 'POST', headers: h }), 'Konto')
    const opts = (Array.isArray(info.privacy_level_options) ? info.privacy_level_options : []) as string[]
    const privacy = opts.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : opts[0] ?? 'SELF_ONLY'
    const size = video.data.byteLength
    const { chunkSize, count } = chunking(size)
    const init = ttData(await callJson(ctx.fetch, 'TikTok', `${API}/v2/post/publish/video/init/`, { method: 'POST', headers: h, body: JSON.stringify({ post_info: { title: [...req.text].slice(0, 2200).join(''), privacy_level: privacy, disable_comment: info.comment_disabled === true, disable_duet: info.duet_disabled === true, disable_stitch: info.stitch_disabled === true, is_aigc: !!req.aiGenerated }, source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count } }) }), 'Start')
    for (let i = 0; i < count; i++) {
      const start = i * chunkSize
      const end = i === count - 1 ? size : start + chunkSize
      const res = await ctx.fetch(String(init.upload_url), { method: 'PUT', headers: { 'Content-Type': video.mime, 'Content-Length': String(end - start), 'Content-Range': `bytes ${start}-${end - 1}/${size}` }, body: video.data.subarray(start, end) as unknown as BodyInit, signal: timeoutSignal(300_000) })
      if (!res.ok && res.status !== 206) throw new PlatformError(`TikTok Upload: HTTP ${res.status}`, res.status)
    }
    const publishId = String(init.publish_id)
    let status = ''
    let postId: string | null = null
    for (let i = 0; i < 12; i++) {
      await wait(ctx, 5000)
      const st = ttData(await callJson(ctx.fetch, 'TikTok', `${API}/v2/post/publish/status/fetch/`, { method: 'POST', headers: h, body: JSON.stringify({ publish_id: publishId }) }), 'Status')
      status = String(st.status ?? '')
      if (status === 'FAILED') throw new PlatformError(`TikTok: ${String(st.fail_reason ?? 'fehlgeschlagen')}`)
      const ids = st.publicaly_available_post_id
      if (Array.isArray(ids) && ids.length) postId = String(ids[0])
      if (status === 'PUBLISH_COMPLETE') break
    }
    return { platform: 'tiktok', ok: true, postId: postId ?? publishId, url: postId && _conn.handle ? `https://www.tiktok.com/@${_conn.handle}/video/${postId}` : null, error: privacy === 'SELF_ONLY' ? 'nur privat sichtbar (App nicht geprüft)' : null }
  },
  async stats(_conn, creds, ref, ctx): Promise<Record<string, number>> {
    if (!ref.postId || !/^\d+$/.test(ref.postId)) return {}
    const token = await accessToken(creds, ctx)
    const d = ttData(await callJson(ctx.fetch, 'TikTok', `${API}/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: { video_ids: [ref.postId] } }) }), 'Zahlen')
    const v = ((Array.isArray(d.videos) ? d.videos[0] : null) ?? {}) as Record<string, number>
    return { reach: v.view_count ?? 0, likes: v.like_count ?? 0, comments: v.comment_count ?? 0, shares: v.share_count ?? 0 }
  },
  async followers(_conn, creds, ctx) {
    const token = await accessToken(creds, ctx)
    const d = ttData(await callJson(ctx.fetch, 'TikTok', `${API}/v2/user/info/?fields=follower_count`, { headers: { Authorization: `Bearer ${token}` } }), 'Profil')
    const n = ((d.user ?? {}) as Json).follower_count
    return typeof n === 'number' ? n : null
  },
}
