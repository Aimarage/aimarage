import type { FetchLike } from '../outlets'
import { callJson, firstUrl, form, jsonOf, errText, PlatformError, timeoutSignal, type Creds, type PlatformAdapter, type SocialConn } from './types'

export const LINKEDIN_VERSION = '202609'
export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social']

export function linkedinAuthorizeUrl(app: { clientId: string, redirectUri: string }, state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: app.redirectUri, state, scope: LINKEDIN_SCOPES.join(' ') })
  return `https://www.linkedin.com/oauth/v2/authorization?${q}`
}

export async function linkedinExchange(app: { clientId: string, clientSecret: string, redirectUri: string }, code: string, f: FetchLike): Promise<{ conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds, expiresAt: string }[]> {
  const t = await callJson(f, 'LinkedIn', 'https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: app.redirectUri, client_id: app.clientId, client_secret: app.clientSecret }) })
  const token = String(t.access_token)
  const me = await callJson(f, 'LinkedIn', 'https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } })
  const expiresAt = new Date(Date.now() + Number(t.expires_in ?? 5_184_000) * 1000).toISOString()
  return [{ conn: { provider: 'linkedin', platform: 'linkedin', name: String(me.name ?? 'LinkedIn'), handle: String(me.sub), ext: { sub: String(me.sub) }, expiresAt }, creds: { accessToken: token }, expiresAt }]
}

export function littleText(s: string): string {
  return s.replace(/[\\()[\]{}<>@|~_*]/g, c => `\\${c}`)
}

function headers(token: string): Record<string, string> {
  return { 'Authorization': `Bearer ${token}`, 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' }
}

export const linkedinAdapter: PlatformAdapter = {
  provider: 'linkedin',
  label: 'LinkedIn',
  platforms: ['linkedin'],
  async post(conn, creds, req, ctx) {
    if (conn.expiresAt && Date.parse(conn.expiresAt) < Date.now()) throw new PlatformError('LinkedIn: Zugang abgelaufen (60 Tage), bitte neu verbinden')
    const token = creds.accessToken!
    const author = `urn:li:person:${conn.ext!.sub}`
    const body: Record<string, unknown> = { author, commentary: littleText(req.text), visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false }
    const img = req.media.find(m => m.mime.startsWith('image/'))
    if (img) {
      const init = await callJson(ctx.fetch, 'LinkedIn', 'https://api.linkedin.com/rest/images?action=initializeUpload', { method: 'POST', headers: headers(token), body: JSON.stringify({ initializeUploadRequest: { owner: author } }) })
      const v = init.value as Record<string, string>
      const put = await ctx.fetch(v.uploadUrl!, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': img.mime }, body: img.data as unknown as BodyInit, signal: timeoutSignal(120_000) })
      if (!put.ok) throw new PlatformError(`LinkedIn Bild: HTTP ${put.status}`, put.status)
      body.content = { media: { id: v.image, altText: '' } }
    }
    else {
      const link = req.link ?? firstUrl(req.text)
      if (link) body.content = { article: { source: link, title: new URL(link).hostname } }
    }
    const res = await ctx.fetch('https://api.linkedin.com/rest/posts', { method: 'POST', headers: headers(token), body: JSON.stringify(body), signal: timeoutSignal(30_000) })
    if (!res.ok) throw new PlatformError(res.status === 401 ? 'LinkedIn: Zugang abgelaufen oder entzogen, bitte neu verbinden' : `LinkedIn: ${errText(await jsonOf(res), res.status)}`, res.status)
    const urn = res.headers.get('x-restli-id') ?? ''
    return { platform: 'linkedin', ok: true, postId: urn || null, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null }
  },
}

export async function verifyLinkedin(creds: Creds, f: FetchLike): Promise<string> {
  const me = await callJson(f, 'LinkedIn', 'https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${creds.accessToken}` } })
  return String(me.name ?? 'LinkedIn')
}
