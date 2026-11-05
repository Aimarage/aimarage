import type { FetchLike, OutletMedia } from '../outlets'
import { callJson, form, PlatformError, type AdapterCtx, type Creds, type PlatformAdapter, type SocialConn, wait } from './types'

export const IG_VERSION = 'v25.0'
const IG = 'https://graph.instagram.com'
const API = `${IG}/${IG_VERSION}`
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights']
export const PUBLIC_MEDIA_HINT = 'Instagram: Medien müssen öffentlich erreichbar sein (Server-Betrieb). Aimarage läuft unter einer lokalen Adresse, dort kann Instagram das Bild nicht abholen. APP_URL (oder PUBLIC_URL) auf eine öffentliche https-Adresse setzen.'

const DAY = 86_400_000
const DEFAULT_TTL_S = 5_184_000

type Json = Record<string, unknown>

const q = (p: Record<string, string>) => new URLSearchParams(p).toString()

function expiry(expiresIn: unknown, at = Date.now()): string {
  const s = Number(expiresIn)
  return new Date(at + (Number.isFinite(s) && s > 0 ? s : DEFAULT_TTL_S) * 1000).toISOString()
}

export function instagramAuthorizeUrl(app: { clientId: string, redirectUri: string }, state: string): string {
  return `https://www.instagram.com/oauth/authorize?${q({ client_id: app.clientId, redirect_uri: app.redirectUri, response_type: 'code', scope: INSTAGRAM_SCOPES.join(','), state, enable_fb_login: 'false', force_reauth: 'true' })}`
}

export async function instagramExchange(app: { clientId: string, clientSecret: string, redirectUri: string }, code: string, f: FetchLike): Promise<{ conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds, expiresAt: string }[]> {
  const short = await callJson(f, 'Instagram', 'https://api.instagram.com/oauth/access_token', { method: 'POST', body: form({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'authorization_code', redirect_uri: app.redirectUri, code: code.replace(/#_$/, '') }) })
  const first = (Array.isArray(short.data) ? short.data[0] : short) as Json | undefined
  const shortToken = typeof first?.access_token === 'string' ? first.access_token : ''
  if (!shortToken) throw new PlatformError('Instagram: kein Zugang erhalten, bitte erneut verbinden')
  const long = await callJson(f, 'Instagram', `${IG}/access_token?${q({ grant_type: 'ig_exchange_token', client_secret: app.clientSecret, access_token: shortToken })}`)
  const token = String(long.access_token ?? '')
  if (!token) throw new PlatformError('Instagram: langlebiger Zugang nicht erhalten')
  const me = await callJson(f, 'Instagram', `${API}/me?${q({ fields: 'user_id,username,account_type', access_token: token })}`)
  const username = String(me.username ?? '')
  const igUserId = String(me.user_id ?? first?.user_id ?? me.id ?? '')
  if (!username || !igUserId) throw new PlatformError('Instagram: Profil nicht lesbar')
  const expiresAt = expiry(long.expires_in)
  return [{
    conn: { provider: 'instagram', platform: 'instagram', name: `@${username}`, handle: username, url: `https://www.instagram.com/${username}/`, ext: { igUserId, ...(typeof me.account_type === 'string' ? { accountType: me.account_type } : {}) }, expiresAt },
    creds: { accessToken: token, issuedAt: new Date().toISOString() },
    expiresAt,
  }]
}

export function needsRefresh(creds: Creds, expiresAt: string | null | undefined, at = Date.now()): boolean {
  const issued = Date.parse(creds.issuedAt ?? '')
  if (Number.isFinite(issued) && at - issued < DAY) return false
  const exp = Date.parse(expiresAt ?? '')
  if (Number.isFinite(exp)) return exp > at && exp - at < 30 * DAY
  return !Number.isFinite(issued) || at - issued > 7 * DAY
}

export async function refreshInstagram(creds: Creds, ctx: AdapterCtx): Promise<{ token: string, expiresAt: string }> {
  const d = await callJson(ctx.fetch, 'Instagram', `${IG}/refresh_access_token?${q({ grant_type: 'ig_refresh_token', access_token: creds.accessToken! })}`)
  const token = String(d.access_token ?? '')
  if (!token) throw new PlatformError('Instagram: Zugang konnte nicht erneuert werden, bitte neu verbinden')
  const expiresAt = expiry(d.expires_in)
  await ctx.saveCreds({ ...creds, accessToken: token, issuedAt: new Date().toISOString() }, expiresAt)
  return { token, expiresAt }
}

async function fresh(conn: SocialConn, creds: Creds, ctx: AdapterCtx): Promise<string> {
  const exp = Date.parse(conn.expiresAt ?? '')
  if (Number.isFinite(exp) && exp < Date.now()) throw new PlatformError('Instagram: Zugang abgelaufen (60 Tage), bitte neu verbinden')
  if (!needsRefresh(creds, conn.expiresAt)) return creds.accessToken!
  try {
    return (await refreshInstagram(creds, ctx)).token
  }
  catch {
    return creds.accessToken!
  }
}

export function checkMedia(media: OutletMedia[]): void {
  if (!media.length) throw new PlatformError('Instagram: Bild oder Video nötig, nur Text geht bei Instagram nicht')
  if (media.length > 10) throw new PlatformError('Instagram: höchstens 10 Bilder oder Videos (Karussell)')
  for (const m of media) {
    if (m.mime.startsWith('image/') && m.mime !== 'image/jpeg') throw new PlatformError('Instagram: nur JPG-Bilder (PNG, WebP oder GIF vorher als JPG speichern)')
    if (!m.mime.startsWith('image/') && !m.mime.startsWith('video/')) throw new PlatformError('Instagram: nur Bilder oder Videos')
  }
  if (media.some(m => !m.url)) throw new PlatformError(PUBLIC_MEDIA_HINT)
}

function mediaHint(err: unknown): never {
  const msg = (err as Error).message
  if (/download|media uri|media url|2207052|9004/i.test(msg)) throw new PlatformError(`${msg} (Instagram konnte die Datei nicht abholen: Medien müssen öffentlich erreichbar sein)`, (err as PlatformError).status)
  throw err
}

async function permalink(id: string, token: string, f: FetchLike): Promise<string | null> {
  try {
    const d = await callJson(f, 'Instagram', `${API}/${id}?${q({ fields: 'permalink', access_token: token })}`)
    return typeof d.permalink === 'string' ? d.permalink : null
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

export const instagramAdapter: PlatformAdapter = {
  provider: 'instagram',
  label: 'Instagram',
  platforms: ['instagram'],
  async post(conn, creds, req, ctx) {
    checkMedia(req.media)
    const token = await fresh(conn, creds, ctx)
    const ig = conn.ext?.igUserId || 'me'
    const f = ctx.fetch
    const create = async (params: Record<string, string>): Promise<string> => {
      try {
        const d = await callJson(f, 'Instagram', `${API}/${ig}/media`, { method: 'POST', body: form({ ...params, access_token: token }) }, 60_000)
        return String(d.id)
      }
      catch (err) {
        return mediaHint(err)
      }
    }
    const ready = async (id: string, video: boolean): Promise<void> => {
      const tries = video ? 30 : 10
      for (let i = 0; i < tries; i++) {
        const st = await callJson(f, 'Instagram', `${API}/${id}?${q({ fields: 'status_code,status', access_token: token })}`)
        if (st.status_code === 'FINISHED' || st.status_code === 'PUBLISHED') return
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') mediaHint(new PlatformError(`Instagram: Datei abgelehnt (${String(st.status_code)}${typeof st.status === 'string' && st.status ? `: ${st.status.slice(0, 200)}` : ''})`))
        await wait(ctx, video ? 10_000 : 3000)
      }
      throw new PlatformError('Instagram: Verarbeitung dauert zu lange, bitte später erneut versuchen')
    }
    const item = (m: OutletMedia, carousel: boolean): Record<string, string> => (m.mime.startsWith('video/') ? { media_type: carousel ? 'VIDEO' : 'REELS', video_url: m.url! } : { image_url: m.url! })
    let creation: string
    if (req.media.length === 1) {
      const m = req.media[0]!
      creation = await create({ ...item(m, false), caption: req.text })
      await ready(creation, m.mime.startsWith('video/'))
    }
    else {
      const children: string[] = []
      for (const m of req.media) {
        const id = await create({ ...item(m, true), is_carousel_item: 'true' })
        await ready(id, m.mime.startsWith('video/'))
        children.push(id)
      }
      creation = await create({ media_type: 'CAROUSEL', children: children.join(','), caption: req.text })
      await ready(creation, false)
    }
    const p = await callJson(f, 'Instagram', `${API}/${ig}/media_publish`, { method: 'POST', body: form({ creation_id: creation, access_token: token }) }, 60_000)
    const id = String(p.id)
    return { platform: 'instagram', ok: true, postId: id, url: await permalink(id, token, f) }
  },
  async stats(_conn, creds, ref, ctx): Promise<Record<string, number>> {
    if (!ref.postId) return {}
    const token = creds.accessToken!
    try {
      const v = insightValues(await callJson(ctx.fetch, 'Instagram', `${API}/${ref.postId}/insights?${q({ metric: 'views,reach,likes,comments,shares,saved', access_token: token })}`))
      return { reach: v.reach ?? v.views ?? 0, likes: v.likes ?? 0, comments: v.comments ?? 0, shares: v.shares ?? 0, saves: v.saved ?? 0 }
    }
    catch {
      const d = await callJson(ctx.fetch, 'Instagram', `${API}/${ref.postId}?${q({ fields: 'like_count,comments_count', access_token: token })}`)
      return { likes: Number(d.like_count ?? 0), comments: Number(d.comments_count ?? 0) }
    }
  },
  async followers(_conn, creds, ctx) {
    const d = await callJson(ctx.fetch, 'Instagram', `${API}/me?${q({ fields: 'followers_count', access_token: creds.accessToken! })}`)
    return typeof d.followers_count === 'number' ? d.followers_count : null
  },
  async refresh(conn, creds, ctx) {
    if (!needsRefresh(creds, conn.expiresAt)) return false
    await refreshInstagram(creds, ctx)
    return true
  },
}

export async function verifyInstagram(creds: Creds, f: FetchLike): Promise<string> {
  const d = await callJson(f, 'Instagram', `${API}/me?${q({ fields: 'username', access_token: creds.accessToken! })}`)
  return `@${String(d.username)}`
}
