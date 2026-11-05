import { createHmac, randomBytes } from 'node:crypto'
import type { FetchLike } from '../outlets'
import { callJson, form, PlatformError, type AdapterCtx, type Creds, type PlatformAdapter, type SocialConn } from './types'

const API = 'https://api.x.com'
export const X_PRICE = { post: 0.015, postWithLink: 0.20 }
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access']

type App = { clientId: string, clientSecret: string, redirectUri: string }
type Json = Record<string, unknown>

export function xAuthorizeUrl(app: Pick<App, 'clientId' | 'redirectUri'>, state: string, challenge: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: app.redirectUri, scope: X_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' })
  return `https://x.com/i/oauth2/authorize?${q}`
}

function tokenCreds(t: Json, prev?: Creds): Creds {
  return { accessToken: String(t.access_token), refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : prev?.refreshToken ?? '', accessExpiresAt: new Date(Date.now() + Number(t.expires_in ?? 7200) * 1000).toISOString() }
}

function tokenCall(f: FetchLike, app: Pick<App, 'clientId' | 'clientSecret'>, params: Record<string, string>): Promise<Json> {
  const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')
  return callJson(f, 'X', `${API}/2/oauth2/token`, { method: 'POST', headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ ...params, client_id: app.clientId }) })
}

export async function xExchange(app: App, code: string, verifier: string | undefined, f: FetchLike): Promise<{ conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds }[]> {
  if (!verifier) throw new PlatformError('X: Anmeldung abgelaufen, bitte "Mit X anmelden" erneut klicken')
  const creds = tokenCreds(await tokenCall(f, app, { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri, code_verifier: verifier }))
  const me = await callJson(f, 'X', `${API}/2/users/me`, { headers: { Authorization: `Bearer ${creds.accessToken}` } })
  const u = me.data as Record<string, string>
  return [{ conn: { provider: 'x', platform: 'x', name: `@${u.username}`, handle: u.username, ext: { userId: u.id!, auth: 'oauth2' } }, creds }]
}

export async function xToken(creds: Creds, ctx: AdapterCtx): Promise<string> {
  if (Date.parse(creds.accessExpiresAt ?? '') - Date.now() > 5 * 60_000) return creds.accessToken!
  if (!creds.refreshToken) throw new PlatformError('X: Zugang abgelaufen, bitte neu verbinden')
  if (!ctx.app) throw new PlatformError('X: App-Schlüssel fehlen (Einstellungen > Plattform-Zugänge, /einstellungen/apps?app=x)')
  let t: Json
  try {
    t = await tokenCall(ctx.fetch, ctx.app, { grant_type: 'refresh_token', refresh_token: creds.refreshToken })
  }
  catch (err) {
    const status = err instanceof PlatformError ? err.status : 0
    if (status === 400 || status === 401) throw new PlatformError('X: Zugang abgelaufen oder entzogen, bitte neu verbinden', status)
    throw err
  }
  const next = tokenCreds(t, creds)
  await ctx.saveCreds(next)
  Object.assign(creds, next)
  return next.accessToken!
}

export function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function oauth1Header(method: string, url: string, creds: Creds, extra: Record<string, string> = {}, nonce = randomBytes(16).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000))): string {
  const u = new URL(url)
  const oauth: Record<string, string> = { oauth_consumer_key: creds.consumerKey!, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: timestamp, oauth_token: creds.token!, oauth_version: '1.0' }
  const params: [string, string][] = [...Object.entries(oauth), ...u.searchParams.entries(), ...Object.entries(extra)].map(([k, v]) => [pct(k), pct(v)])
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  const base = `${method.toUpperCase()}&${pct(`${u.origin}${u.pathname}`)}&${pct(params.map(([k, v]) => `${k}=${v}`).join('&'))}`
  const sig = createHmac('sha1', `${pct(creds.consumerSecret!)}&${pct(creds.tokenSecret!)}`).update(base).digest('base64')
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: sig }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`
}

async function auth(method: string, url: string, creds: Creds, ctx: AdapterCtx): Promise<Record<string, string>> {
  if (creds.accessToken) return { Authorization: `Bearer ${await xToken(creds, ctx)}` }
  return { Authorization: oauth1Header(method, url, creds) }
}

export async function xMe(creds: Creds, ctx: AdapterCtx, fields = ''): Promise<Json> {
  const url = `${API}/2/users/me${fields ? `?user.fields=${fields}` : ''}`
  const d = await callJson(ctx.fetch, 'X', url, { headers: await auth('GET', url, creds, ctx) })
  return (d.data ?? {}) as Json
}

// X zählt einen Post mit Link teurer; als Link gilt auch eine nackte Domain, die X selbst verlinkt (z.B. example.com).
const LINK = /https?:\/\/|\bwww\.[a-z0-9-]+\.|(^|[^@\w.-])[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(com|net|org|io|ai|app|dev|co|me|info|biz|eu|de|at|ch|uk|fr|it|es|nl|be|pl|us|ca|tv|fm|link|ly|gl|gg|xyz|site|online|shop|store|tech|page|blog|news|music|studio|so|to|sh|cc)\b(?![-\w])/i

export function xHasLink(text: string): boolean {
  return LINK.test(text)
}

export function xPostUnits(parts: string[]): { posts: number, linkPosts: number } {
  const used = parts.filter(p => p.trim())
  const linkPosts = used.filter(xHasLink).length
  return { posts: used.length - linkPosts, linkPosts }
}

export function xCost(text: string): number {
  return xHasLink(text) ? X_PRICE.postWithLink : X_PRICE.post
}

export const xAdapter: PlatformAdapter = {
  provider: 'x',
  label: 'X',
  platforms: ['x'],
  async post(conn, creds, req, ctx) {
    const mediaIds: string[] = []
    for (const m of req.media.filter(x => x.mime.startsWith('image/')).slice(0, 4)) {
      const url = `${API}/2/media/upload`
      const fd = new FormData()
      fd.append('media', new Blob([m.data as unknown as ArrayBuffer], { type: m.mime }), m.name)
      fd.append('media_category', 'tweet_image')
      const d = await callJson(ctx.fetch, 'X', url, { method: 'POST', headers: await auth('POST', url, creds, ctx), body: fd }, 120_000)
      const id = (d.data as Record<string, unknown> | undefined)?.id ?? d.media_id_string
      if (!id) throw new PlatformError('X: Bild-Upload ohne ID')
      mediaIds.push(String(id))
    }
    const url = `${API}/2/tweets`
    const d = await callJson(ctx.fetch, 'X', url, { method: 'POST', headers: { ...(await auth('POST', url, creds, ctx)), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: req.text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) }) })
    const id = String((d.data as Record<string, unknown>).id)
    return { platform: 'x', ok: true, postId: id, url: `https://x.com/${conn.handle ?? 'i'}/status/${id}` }
  },
  async stats(_conn, creds, ref, ctx): Promise<Record<string, number>> {
    if (!ref.postId) return {}
    const url = `${API}/2/tweets?ids=${encodeURIComponent(ref.postId)}&tweet.fields=public_metrics`
    const d = await callJson(ctx.fetch, 'X', url, { headers: await auth('GET', url, creds, ctx) })
    const m = ((Array.isArray(d.data) ? d.data[0] : null) as Record<string, unknown> | null)?.public_metrics as Record<string, number> | undefined
    if (!m) return {}
    return { reach: m.impression_count ?? 0, likes: m.like_count ?? 0, comments: m.reply_count ?? 0, shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0) }
  },
  async followers(_conn, creds, ctx) {
    const m = (await xMe(creds, ctx, 'public_metrics')).public_metrics as Record<string, number> | undefined
    return typeof m?.followers_count === 'number' ? m.followers_count : null
  },
}

export async function verifyX(input: { consumerKey: string, consumerSecret: string, token: string, tokenSecret: string }, f: FetchLike): Promise<{ creds: Creds, conn: Omit<SocialConn, 'id' | 'secret'> }> {
  const creds: Creds = { ...input }
  const u = await xMe(creds, { fetch: f, saveCreds: async () => {} }) as Record<string, string>
  return { creds, conn: { provider: 'x', platform: 'x', name: `@${u.username}`, handle: u.username, ext: { userId: u.id! } } }
}
