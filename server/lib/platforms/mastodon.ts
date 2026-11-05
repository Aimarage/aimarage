import type { FetchLike } from '../outlets'
import { errText, jsonOf, PlatformError, timeoutSignal, type Creds, type PlatformAdapter, type SocialConn, wait } from './types'

type Json = Record<string, unknown>

export function mastodonBase(url: string | null | undefined): string {
  const raw = (url ?? '').trim().replace(/\/+$/, '')
  if (!raw) throw new PlatformError('Mastodon: Instanz-Adresse fehlt')
  const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`)
  if (u.protocol !== 'https:') throw new PlatformError('Mastodon: nur https-Instanzen')
  return u.origin
}


async function api(base: string, token: string, path: string, init: RequestInit, f: FetchLike, ms = 30_000): Promise<Json> {
  const res = await f(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers as Record<string, string> ?? {}) }, signal: timeoutSignal(ms) })
  const data = await jsonOf(res)
  if (!res.ok && res.status !== 202) throw new PlatformError(res.status === 401 ? 'Mastodon: Zugangstoken abgelehnt' : `Mastodon: ${errText(data, res.status)}`, res.status)
  return data
}

export const mastodonAdapter: PlatformAdapter = {
  provider: 'mastodon',
  label: 'Mastodon',
  platforms: ['mastodon'],
  async post(conn, creds, req, ctx) {
    const base = mastodonBase(conn.url)
    const ids: string[] = []
    for (const m of req.media.slice(0, 4)) {
      const fd = new FormData()
      fd.append('file', new Blob([m.data as unknown as ArrayBuffer], { type: m.mime }), m.name)
      const up = await api(base, creds.token!, '/api/v2/media', { method: 'POST', body: fd }, ctx.fetch, 120_000)
      let media = up
      for (let i = 0; i < 20 && !media.url; i++) {
        await wait(ctx, 1500)
        media = await api(base, creds.token!, `/api/v1/media/${encodeURIComponent(String(up.id))}`, { method: 'GET' }, ctx.fetch)
      }
      ids.push(String(up.id))
    }
    const body = { status: req.text, visibility: 'public', ...(ids.length ? { media_ids: ids } : {}) }
    const data = await api(base, creds.token!, '/api/v1/statuses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `ma-${conn.id}-${req.text.length}-${ids.join('')}`.slice(0, 64) }, body: JSON.stringify(body) }, ctx.fetch)
    return { platform: 'mastodon', ok: true, postId: String(data.id), url: typeof data.url === 'string' ? data.url : null }
  },
  async stats(conn, creds, ref, ctx): Promise<Record<string, number>> {
    if (!ref.postId) return {}
    const d = await api(mastodonBase(conn.url), creds.token!, `/api/v1/statuses/${encodeURIComponent(ref.postId)}`, { method: 'GET' }, ctx.fetch)
    return { likes: Number(d.favourites_count ?? 0), shares: Number(d.reblogs_count ?? 0), comments: Number(d.replies_count ?? 0) }
  },
  async followers(conn, creds, ctx) {
    const d = await api(mastodonBase(conn.url), creds.token!, '/api/v1/accounts/verify_credentials', { method: 'GET' }, ctx.fetch)
    return typeof d.followers_count === 'number' ? d.followers_count : null
  },
}

export async function verifyMastodon(input: { url: string, token: string }, f: FetchLike): Promise<{ creds: Creds, conn: Omit<SocialConn, 'id' | 'secret'> }> {
  const base = mastodonBase(input.url)
  const d = await api(base, input.token, '/api/v1/accounts/verify_credentials', { method: 'GET' }, f, 15_000)
  const handle = `${String(d.acct ?? d.username)}@${new URL(base).host}`
  return { creds: { token: input.token }, conn: { provider: 'mastodon', platform: 'mastodon', name: `@${handle}`, handle, url: base, ext: { accountId: String(d.id) } } }
}
