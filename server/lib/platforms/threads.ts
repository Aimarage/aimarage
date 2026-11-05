import type { FetchLike, OutletMedia } from '../outlets'
import { callJson, firstUrl, form, PlatformError, type Creds, type PlatformAdapter, type SocialConn, wait } from './types'

const TH = 'https://graph.threads.net'
export const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_insights']

type Json = Record<string, unknown>

export const THREADS_MEDIA_HINT = 'Threads: Bilder und Videos müssen öffentlich erreichbar sein (Server-Betrieb). Aimarage läuft unter einer lokalen Adresse, dort kann Threads die Datei nicht abholen. APP_URL (oder PUBLIC_URL) auf eine öffentliche https-Adresse setzen.'

export function checkThreadsMedia(media: OutletMedia[]): void {
  if (media.length > 20) throw new PlatformError('Threads: höchstens 20 Bilder oder Videos (Karussell)')
  for (const m of media) {
    if (m.mime.startsWith('image/') && m.mime !== 'image/jpeg' && m.mime !== 'image/png') throw new PlatformError('Threads: nur JPG- oder PNG-Bilder')
    if (!m.mime.startsWith('image/') && !m.mime.startsWith('video/')) throw new PlatformError('Threads: nur Bilder oder Videos')
  }
  if (media.some(m => !m.url)) throw new PlatformError(THREADS_MEDIA_HINT)
}

export function threadsAuthorizeUrl(app: { clientId: string, redirectUri: string }, state: string): string {
  const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: app.redirectUri, scope: THREADS_SCOPES.join(','), response_type: 'code', state })
  return `https://threads.net/oauth/authorize?${q}`
}

export async function threadsExchange(app: { clientId: string, clientSecret: string, redirectUri: string }, code: string, f: FetchLike): Promise<{ conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds, expiresAt: string }[]> {
  const short = await callJson(f, 'Threads', `${TH}/oauth/access_token`, { method: 'POST', body: form({ client_id: app.clientId, client_secret: app.clientSecret, code: code.replace(/#_$/, ''), grant_type: 'authorization_code', redirect_uri: app.redirectUri }) })
  const long = await callJson(f, 'Threads', `${TH}/access_token?${new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: app.clientSecret, access_token: String(short.access_token) })}`)
  const token = String(long.access_token)
  const me = await callJson(f, 'Threads', `${TH}/v1.0/me?${new URLSearchParams({ fields: 'id,username', access_token: token })}`)
  const expiresAt = new Date(Date.now() + Number(long.expires_in ?? 5_184_000) * 1000).toISOString()
  return [{ conn: { provider: 'threads', platform: 'threads', name: `@${String(me.username)}`, handle: String(me.username), ext: { userId: String(me.id) }, expiresAt }, creds: { accessToken: token, issuedAt: new Date().toISOString() }, expiresAt }]
}

async function fresh(creds: Creds, ctx: Parameters<PlatformAdapter['post']>[3]): Promise<string> {
  const issued = Date.parse(creds.issuedAt ?? '')
  if (Number.isFinite(issued) && Date.now() - issued > 7 * 86_400_000) {
    try {
      const d = await callJson(ctx.fetch, 'Threads', `${TH}/refresh_access_token?${new URLSearchParams({ grant_type: 'th_refresh_token', access_token: creds.accessToken! })}`)
      const token = String(d.access_token)
      await ctx.saveCreds({ ...creds, accessToken: token, issuedAt: new Date().toISOString() }, new Date(Date.now() + Number(d.expires_in ?? 5_184_000) * 1000).toISOString())
      return token
    }
    catch {
      return creds.accessToken!
    }
  }
  return creds.accessToken!
}

export const threadsAdapter: PlatformAdapter = {
  provider: 'threads',
  label: 'Threads',
  platforms: ['threads'],
  async post(conn, creds, req, ctx) {
    checkThreadsMedia(req.media)
    const token = await fresh(creds, ctx)
    const f = ctx.fetch
    const user = conn.ext?.userId || 'me'
    const create = async (params: Record<string, string>): Promise<string> => {
      try {
        return String((await callJson(f, 'Threads', `${TH}/v1.0/${user}/threads`, { method: 'POST', body: form({ ...params, access_token: token }) }, 60_000)).id)
      }
      catch (err) {
        const msg = (err as Error).message
        if (/download|media|fetch|2207052/i.test(msg) && params.media_type !== 'TEXT') throw new PlatformError(`${msg} (Threads konnte die Datei nicht abholen: Medien müssen öffentlich erreichbar sein)`, (err as PlatformError).status)
        throw err
      }
    }
    const ready = async (id: string, video: boolean): Promise<void> => {
      const tries = video ? 30 : 10
      for (let i = 0; i < tries; i++) {
        await wait(ctx, video ? 10_000 : 3000)
        const st = await callJson(f, 'Threads', `${TH}/v1.0/${id}?${new URLSearchParams({ fields: 'status,error_message', access_token: token })}`)
        if (st.status === 'FINISHED' || st.status === 'PUBLISHED') return
        if (st.status === 'ERROR' || st.status === 'EXPIRED') throw new PlatformError(`Threads: Datei abgelehnt (${String(st.status)}${typeof st.error_message === 'string' && st.error_message ? `: ${st.error_message.slice(0, 200)}` : ''})`)
      }
      throw new PlatformError('Threads: Verarbeitung dauert zu lange, bitte später erneut versuchen')
    }
    const item = (m: OutletMedia): Record<string, string> => (m.mime.startsWith('video/') ? { media_type: 'VIDEO', video_url: m.url! } : { media_type: 'IMAGE', image_url: m.url! })
    let creation: string
    if (!req.media.length) {
      const link = req.link ?? firstUrl(req.text)
      creation = await create({ media_type: 'TEXT', text: req.text, ...(link ? { link_attachment: link } : {}) })
      await wait(ctx, 5000)
    }
    else if (req.media.length === 1) {
      const m = req.media[0]!
      creation = await create({ ...item(m), text: req.text })
      await ready(creation, m.mime.startsWith('video/'))
    }
    else {
      const children: string[] = []
      for (const m of req.media) {
        const id = await create({ ...item(m), is_carousel_item: 'true' })
        await ready(id, m.mime.startsWith('video/'))
        children.push(id)
      }
      creation = await create({ media_type: 'CAROUSEL', children: children.join(','), text: req.text })
      await ready(creation, false)
    }
    const p = await callJson(f, 'Threads', `${TH}/v1.0/${user}/threads_publish`, { method: 'POST', body: form({ creation_id: creation, access_token: token }) }, 60_000)
    const id = String(p.id)
    let url: string | null = null
    try {
      const d = await callJson(f, 'Threads', `${TH}/v1.0/${id}?${new URLSearchParams({ fields: 'permalink', access_token: token })}`)
      url = typeof d.permalink === 'string' ? d.permalink : null
    }
    catch {
      url = null
    }
    return { platform: 'threads', ok: true, postId: id, url }
  },
  async stats(_conn, creds, ref, ctx): Promise<Record<string, number>> {
    if (!ref.postId) return {}
    const d = await callJson(ctx.fetch, 'Threads', `${TH}/v1.0/${ref.postId}/insights?${new URLSearchParams({ metric: 'views,likes,replies,reposts,quotes,shares', access_token: creds.accessToken! })}`)
    const v: Record<string, number> = {}
    for (const x of (Array.isArray(d.data) ? d.data : []) as Json[]) {
      const val = (Array.isArray(x.values) ? (x.values[0] as Json)?.value : (x.total_value as Json)?.value) as unknown
      if (typeof val === 'number') v[String(x.name)] = val
    }
    return { reach: v.views ?? 0, likes: v.likes ?? 0, comments: v.replies ?? 0, shares: (v.reposts ?? 0) + (v.quotes ?? 0) + (v.shares ?? 0) }
  },
  async followers(conn, creds, ctx) {
    const d = await callJson(ctx.fetch, 'Threads', `${TH}/v1.0/${conn.ext?.userId ?? 'me'}/threads_insights?${new URLSearchParams({ metric: 'followers_count', access_token: creds.accessToken! })}`)
    const x = ((Array.isArray(d.data) ? d.data : []) as Json[]).find(i => i.name === 'followers_count')
    const v = (x?.total_value as Json)?.value
    return typeof v === 'number' ? v : null
  },
}
