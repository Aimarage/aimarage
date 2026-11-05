import { isVertical, videoInfo } from '../mp4'
import type { FetchLike, OutletMedia } from '../outlets'
import { errText, jsonOf, PlatformError, timeoutSignal, type AdapterCtx, type Creds, type PlatformAdapter, type SocialConn, wait } from './types'

export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos'
export const CHUNK = 32 * 256 * 1024
export const SHORTS_MAX_S = 180
export const YT_PRIVACY = ['public', 'unlisted', 'private'] as const
export const YT_CATEGORIES = ['10', '22', '24', '1', '27', '28', '26', '25', '20'] as const
export const DEFAULT_CATEGORY = '22'

type Json = Record<string, unknown>
type App = { clientId: string, clientSecret: string, redirectUri: string }

export function youtubeAuthorizeUrl(app: Pick<App, 'clientId' | 'redirectUri'>, state: string): string {
  const u = new URL(AUTH_URL)
  u.searchParams.set('client_id', app.clientId)
  u.searchParams.set('redirect_uri', app.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', YOUTUBE_SCOPES.join(' '))
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'select_account consent')
  u.searchParams.set('state', state)
  return u.toString()
}

function googleError(label: string, data: Json, status: number): PlatformError {
  const e = data.error as Json | string | undefined
  const reason = typeof e === 'object' && Array.isArray(e?.errors) ? String(((e.errors[0] ?? {}) as Json).reason ?? '') : ''
  if (status === 401 || data.error === 'invalid_grant') return new PlatformError(`${label}: Google-Zugang abgelaufen oder widerrufen, bitte neu verbinden`, status)
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') return new PlatformError(`${label}: Tageskontingent der YouTube-API erschöpft, morgen erneut versuchen`, status)
  if (reason === 'youtubeSignupRequired') return new PlatformError(`${label}: Das Google-Konto hat noch keinen YouTube-Kanal`, status)
  if (status === 403 && /has not been used|is disabled|accessNotConfigured/i.test(JSON.stringify(data))) return new PlatformError(`${label}: Die "YouTube Data API v3" ist im Google-Cloud-Projekt nicht aktiviert`, status)
  return new PlatformError(`${label}: ${errText(data, status)}`, status)
}

async function gJson(f: FetchLike, url: string, init: RequestInit, ms = 30_000): Promise<Json> {
  let res: Response
  try {
    res = await f(url, { method: 'GET', ...init, signal: timeoutSignal(ms) })
  }
  catch (err) {
    throw new PlatformError(`YouTube: nicht erreichbar (${(err as Error).message.replace(/\?[^\s)]*/g, '').slice(0, 120)})`)
  }
  const data = await jsonOf(res)
  if (!res.ok) throw googleError('YouTube', data, res.status)
  return data
}

function expiresAt(expiresIn: unknown): string {
  const s = Number(expiresIn)
  return new Date(Date.now() + (Number.isFinite(s) && s > 0 ? s : 3600) * 1000).toISOString()
}

async function myChannel(token: string, f: FetchLike): Promise<Json | null> {
  const d = await gJson(f, `${API}/channels?part=snippet,statistics&mine=true`, { headers: { Authorization: `Bearer ${token}` } })
  return ((Array.isArray(d.items) ? d.items : []) as Json[])[0] ?? null
}

export async function youtubeExchange(app: App, code: string, f: FetchLike): Promise<{ conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds }[]> {
  const t = await gJson(f, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri, grant_type: 'authorization_code' }) })
  const refreshToken = typeof t.refresh_token === 'string' ? t.refresh_token : ''
  const accessToken = typeof t.access_token === 'string' ? t.access_token : ''
  if (!refreshToken || !accessToken) throw new PlatformError('YouTube: Google hat keinen dauerhaften Zugang geliefert, bitte erneut verbinden')
  if (typeof t.scope === 'string' && !t.scope.includes('youtube.upload')) throw new PlatformError('YouTube: Hochladen wurde nicht erlaubt, beim Anmelden alle Haken setzen')
  const ch = await myChannel(accessToken, f)
  if (!ch) throw new PlatformError('YouTube: Zu diesem Google-Konto gibt es keinen YouTube-Kanal. Beim Anmelden den richtigen Kanal (bzw. das Brand-Konto) wählen.')
  const sn = (ch.snippet ?? {}) as Json
  const channelId = String(ch.id)
  const handle = typeof sn.customUrl === 'string' ? sn.customUrl.replace(/^@/, '') : null
  return [{
    conn: { provider: 'youtube', platform: 'youtube', name: String(sn.title ?? channelId), handle, url: handle ? `https://www.youtube.com/@${handle}` : `https://www.youtube.com/channel/${channelId}`, ext: { channelId, categoryId: DEFAULT_CATEGORY, privacy: 'public' } },
    creds: { refreshToken, accessToken, accessExpiresAt: expiresAt(t.expires_in) },
  }]
}

export async function youtubeToken(creds: Creds, ctx: AdapterCtx): Promise<string> {
  const exp = Date.parse(creds.accessExpiresAt ?? '')
  if (creds.accessToken && Number.isFinite(exp) && exp - Date.now() > 120_000) return creds.accessToken
  if (!ctx.app) throw new PlatformError('YouTube: Google-Zugang (Client-ID und Clientschlüssel) fehlt unter Einstellungen > Plattform-Zugänge')
  if (!creds.refreshToken) throw new PlatformError('YouTube: Zugang unvollständig, bitte neu verbinden')
  const d = await gJson(ctx.fetch, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ refresh_token: creds.refreshToken, client_id: ctx.app.clientId, client_secret: ctx.app.clientSecret, grant_type: 'refresh_token' }) })
  const token = typeof d.access_token === 'string' ? d.access_token : ''
  if (!token) throw new PlatformError('YouTube: Google hat keinen Zugang geliefert, bitte neu verbinden')
  await ctx.saveCreds({ ...creds, accessToken: token, accessExpiresAt: expiresAt(d.expires_in), ...(typeof d.refresh_token === 'string' ? { refreshToken: d.refresh_token } : {}) })
  return token
}

const clean = (s: string) => s.replace(/[<>]/g, '')

export function videoTitle(title: string | null | undefined, text: string): string {
  const own = clean(title ?? '').replace(/\s+/g, ' ').trim()
  const line = own || clean(text).split('\n').map(l => l.replace(/https?:\/\/\S+/g, '').replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim()).find(Boolean) || 'Video'
  const chars = [...line]
  return chars.length > 100 ? `${chars.slice(0, 99).join('').trimEnd()}…` : line
}

export function videoTags(text: string): string[] {
  const out: string[] = []
  let total = 0
  for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_]{2,40})/gu)) {
    const tag = m[1]!
    if (tag.toLowerCase() === 'shorts' || out.some(t => t.toLowerCase() === tag.toLowerCase())) continue
    if (total + tag.length + 1 > 450) break
    out.push(tag)
    total += tag.length + 1
  }
  return out
}

export function isShort(m: OutletMedia): boolean {
  const info = videoInfo(m.data)
  return isVertical(info) === true && info.seconds !== null && info.seconds <= SHORTS_MAX_S
}

export function videoDescription(text: string, short: boolean): string {
  let d = clean(text).trim()
  if (short && !/(^|\s)#shorts\b/i.test(d)) d = `${d}\n\n#Shorts`
  const enc = new TextEncoder()
  while (enc.encode(d).length > 5000) d = d.slice(0, -50)
  return d
}

export function checkYoutubeMedia(media: OutletMedia[]): OutletMedia {
  const videos = media.filter(m => m.mime.startsWith('video/'))
  if (!videos.length) throw new PlatformError('YouTube: Video nötig')
  if (videos.length > 1) throw new PlatformError('YouTube: nur ein Video je Beitrag')
  return videos[0]!
}

async function put(f: FetchLike, url: string, headers: Record<string, string>, body: Uint8Array | string): Promise<Response> {
  return f(url, { method: 'PUT', headers, body: body as unknown as BodyInit, redirect: 'manual', signal: timeoutSignal(300_000) })
}

function nextByte(res: Response): number {
  const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '')
  return m ? Number(m[1]) + 1 : 0
}

export async function resumableUpload(f: FetchLike, session: string, token: string, video: OutletMedia, ctx: { sleep?: (ms: number) => Promise<void> }): Promise<Json> {
  const total = video.data.byteLength
  let at = 0
  let fails = 0
  while (true) {
    const end = Math.min(at + CHUNK, total)
    let res: Response | null = null
    try {
      res = await put(f, session, { 'Authorization': `Bearer ${token}`, 'Content-Type': video.mime, 'Content-Range': `bytes ${at}-${end - 1}/${total}` }, video.data.subarray(at, end))
    }
    catch {
      res = null
    }
    if (res && (res.status === 200 || res.status === 201)) return jsonOf(res)
    if (res && res.status === 308) {
      at = nextByte(res)
      fails = 0
      continue
    }
    if (res && res.status === 404) throw new PlatformError('YouTube: Upload-Sitzung abgelaufen, bitte erneut posten', 404)
    if (res && res.status < 500) throw googleError('YouTube', await jsonOf(res), res.status)
    if (++fails > 4) throw new PlatformError(`YouTube: Upload mehrfach abgebrochen${res ? ` (HTTP ${res.status})` : ''}, bitte später erneut posten`)
    await wait(ctx, 2000 * 2 ** fails)
    let st: Response | null = null
    try {
      st = await put(f, session, { 'Authorization': `Bearer ${token}`, 'Content-Range': `bytes */${total}` }, '')
    }
    catch {
      st = null
    }
    if (st && (st.status === 200 || st.status === 201)) return jsonOf(st)
    if (st && st.status === 404) throw new PlatformError('YouTube: Upload-Sitzung abgelaufen, bitte erneut posten', 404)
    if (st && st.status === 308) at = nextByte(st)
  }
}

export interface YoutubeOptions {
  categoryId: string
  privacy: typeof YT_PRIVACY[number]
  synthetic: boolean
}

export function youtubeOptions(conn: Pick<SocialConn, 'ext'>): YoutubeOptions {
  const privacy = (YT_PRIVACY as readonly string[]).includes(conn.ext?.privacy ?? '') ? conn.ext!.privacy as YoutubeOptions['privacy'] : 'public'
  return { categoryId: conn.ext?.categoryId || DEFAULT_CATEGORY, privacy, synthetic: conn.ext?.synthetic === 'true' }
}

export const youtubeAdapter: PlatformAdapter = {
  provider: 'youtube',
  label: 'YouTube',
  platforms: ['youtube'],
  async post(conn, creds, req, ctx) {
    const video = checkYoutubeMedia(req.media)
    const token = await youtubeToken(creds, ctx)
    const short = isShort(video)
    const opt = youtubeOptions(conn)
    const privacy = opt.privacy
    const meta = {
      snippet: { title: videoTitle(req.title, req.text), description: videoDescription(req.text, short), tags: videoTags(req.text), categoryId: opt.categoryId },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, ...(opt.synthetic || req.aiGenerated ? { containsSyntheticMedia: true } : {}) },
    }
    let res: Response
    try {
      res = await ctx.fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(video.data.byteLength), 'X-Upload-Content-Type': video.mime }, body: JSON.stringify(meta), signal: timeoutSignal(60_000) })
    }
    catch (err) {
      throw new PlatformError(`YouTube: nicht erreichbar (${(err as Error).message.slice(0, 120)})`)
    }
    if (!res.ok) throw googleError('YouTube', await jsonOf(res), res.status)
    const session = res.headers.get('location')
    if (!session) throw new PlatformError('YouTube: keine Upload-Adresse erhalten')
    const v = await resumableUpload(ctx.fetch, session, token, video, ctx)
    const id = typeof v.id === 'string' ? v.id : ''
    if (!id) throw new PlatformError('YouTube: Upload ohne Video-ID beendet')
    const got = String(((v.status ?? {}) as Json).privacyStatus ?? privacy)
    return {
      platform: 'youtube',
      ok: true,
      postId: id,
      url: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
      ...(got !== privacy ? { error: `YouTube hat das Video auf "${got}" gesetzt statt "${privacy}" (API-Projekt nicht geprüft?)` } : {}),
    }
  },
  async stats(_conn, creds, ref, ctx) {
    if (!ref.postId) return {}
    const token = await youtubeToken(creds, ctx)
    const d = await gJson(ctx.fetch, `${API}/videos?part=statistics&id=${encodeURIComponent(ref.postId)}`, { headers: { Authorization: `Bearer ${token}` } })
    const s = ((((Array.isArray(d.items) ? d.items : []) as Json[])[0] ?? {}).statistics ?? {}) as Json
    const out: Record<string, number> = {}
    for (const [k, n] of [['viewCount', 'views'], ['likeCount', 'likes'], ['commentCount', 'comments']] as const) if (s[k] !== undefined) out[n] = Number(s[k]) || 0
    return out
  },
  async followers(_conn, creds, ctx) {
    const ch = await myChannel(await youtubeToken(creds, ctx), ctx.fetch)
    const st = (ch?.statistics ?? {}) as Json
    return st.hiddenSubscriberCount === true || st.subscriberCount === undefined ? null : Number(st.subscriberCount) || 0
  },
}

export async function verifyYoutube(creds: Creds, ctx: AdapterCtx): Promise<string> {
  const ch = await myChannel(await youtubeToken(creds, ctx), ctx.fetch)
  if (!ch) throw new PlatformError('YouTube: Kanal nicht gefunden')
  return String(((ch.snippet ?? {}) as Json).title ?? ch.id)
}

