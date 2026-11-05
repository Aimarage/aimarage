import { shortUrl } from '../../../shared/utils/social'
import type { FetchLike } from '../outlets'
import { bytesLength, errText, firstUrl, jsonOf, PlatformError, timeoutSignal, type Creds, type PlatformAdapter, type SocialConn } from './types'

const PDS = 'https://bsky.social'
const PUBLIC = 'https://public.api.bsky.app'
export const BSKY_MAX_IMAGE = 1_000_000

type Json = Record<string, unknown>

function pds(conn: Pick<SocialConn, 'url'>): string {
  return (conn.url || PDS).replace(/\/+$/, '')
}

export async function bskySession(base: string, identifier: string, password: string, f: FetchLike): Promise<{ accessJwt: string, did: string, handle: string }> {
  const res = await f(`${base}/xrpc/com.atproto.server.createSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: identifier.trim().replace(/^@/, ''), password: password.trim() }), signal: timeoutSignal(15_000) })
  const data = await jsonOf(res)
  if (!res.ok) throw new PlatformError(res.status === 401 && data.error !== 'AuthFactorTokenRequired' ? 'Bluesky: Handle oder App-Passwort falsch' : `Bluesky: ${errText(data, res.status)}`, res.status)
  return { accessJwt: String(data.accessJwt), did: String(data.did), handle: String(data.handle) }
}

export interface Facet {
  index: { byteStart: number, byteEnd: number }
  features: Json[]
}

export function bskyFacets(text: string): Facet[] {
  const out: Facet[] = []
  const add = (start: number, match: string, feature: Json) => {
    const byteStart = bytesLength(text.slice(0, start))
    out.push({ index: { byteStart, byteEnd: byteStart + bytesLength(match) }, features: [feature] })
  }
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    add(m.index!, url, { $type: 'app.bsky.richtext.facet#link', uri: url })
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const start = m.index! + m[1]!.length
    add(start, `#${m[2]}`, { $type: 'app.bsky.richtext.facet#tag', tag: m[2] })
  }
  return out.sort((a, b) => a.index.byteStart - b.index.byteStart)
}

export function bskyRichText(text: string): { text: string, facets: Facet[] } {
  let out = ''
  let last = 0
  const links: Facet[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    const short = shortUrl(url)
    out += text.slice(last, m.index)
    const byteStart = bytesLength(out)
    out += short
    links.push({ index: { byteStart, byteEnd: byteStart + bytesLength(short) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] })
    last = m.index! + url.length
  }
  out += text.slice(last)
  const tags = bskyFacets(out).filter(f => f.features[0]!.$type === 'app.bsky.richtext.facet#tag')
  return { text: out, facets: [...links, ...tags].sort((a, b) => a.index.byteStart - b.index.byteStart) }
}

async function uploadBlob(base: string, jwt: string, data: Uint8Array, mime: string, f: FetchLike): Promise<Json> {
  if (data.byteLength > BSKY_MAX_IMAGE) throw new PlatformError('Bluesky: Bild größer als 1 MB')
  const res = await f(`${base}/xrpc/com.atproto.repo.uploadBlob`, { method: 'POST', headers: { 'Content-Type': mime, 'Authorization': `Bearer ${jwt}` }, body: data as unknown as BodyInit, signal: timeoutSignal(60_000) })
  const json = await jsonOf(res)
  if (!res.ok) throw new PlatformError(`Bluesky Bild: ${errText(json, res.status)}`, res.status)
  return json.blob as Json
}

export async function linkCard(url: string, f: FetchLike): Promise<{ title: string, description: string, image: string | null }> {
  try {
    const res = await f(url, { method: 'GET', headers: { Accept: 'text/html' }, signal: timeoutSignal(6_000) })
    const html = (await res.text()).slice(0, 300_000)
    const meta = (p: string) => new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)`, 'i').exec(html)?.[1] ?? ''
    const title = meta('og:title') || /<title[^>]*>([^<]*)/i.exec(html)?.[1] || new URL(url).hostname
    const img = meta('og:image') || meta('twitter:image')
    let image: string | null = null
    try {
      image = img ? new URL(img, url).href : null
    }
    catch {}
    return { title: title.trim().slice(0, 300), description: (meta('og:description') || meta('description')).trim().slice(0, 1000), image }
  }
  catch {
    return { title: new URL(url).hostname, description: '', image: null }
  }
}

async function cardThumb(base: string, jwt: string, src: string, f: FetchLike): Promise<Json | null> {
  try {
    const res = await f(src, { method: 'GET', headers: { Accept: 'image/*' }, signal: timeoutSignal(10_000) })
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null
    const data = new Uint8Array(await res.arrayBuffer())
    return data.byteLength <= BSKY_MAX_IMAGE ? await uploadBlob(base, jwt, data, mime, f) : null
  }
  catch {
    return null
  }
}

export function rkeyOf(uri: string): string {
  return uri.split('/').pop() ?? ''
}

export const blueskyAdapter: PlatformAdapter = {
  provider: 'bluesky',
  label: 'Bluesky',
  platforms: ['bluesky'],
  async post(conn, creds, req, ctx) {
    const base = pds(conn)
    const s = await bskySession(base, creds.identifier!, creds.password!, ctx.fetch)
    const rich = bskyRichText(req.text)
    const record: Json = { $type: 'app.bsky.feed.post', text: rich.text, createdAt: new Date().toISOString() }
    const facets = rich.facets
    if (facets.length) record.facets = facets
    const images = req.media.filter(m => m.mime.startsWith('image/') && m.data.byteLength <= BSKY_MAX_IMAGE).slice(0, 4)
    if (images.length) {
      const blobs = []
      for (const m of images) blobs.push({ alt: '', image: await uploadBlob(base, s.accessJwt, m.data, m.mime, ctx.fetch) })
      record.embed = { $type: 'app.bsky.embed.images', images: blobs }
    }
    else {
      const link = req.link ?? firstUrl(req.text)
      if (link) {
        const { image, ...card } = await linkCard(link, ctx.fetch)
        const thumb = image ? await cardThumb(base, s.accessJwt, image, ctx.fetch) : null
        record.embed = { $type: 'app.bsky.embed.external', external: { uri: link, ...card, ...(thumb ? { thumb } : {}) } }
      }
    }
    const res = await ctx.fetch(`${base}/xrpc/com.atproto.repo.createRecord`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.accessJwt}` }, body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record }), signal: timeoutSignal(30_000) })
    const data = await jsonOf(res)
    if (!res.ok) throw new PlatformError(`Bluesky: ${errText(data, res.status)}`, res.status)
    const uri = String(data.uri)
    return { platform: 'bluesky', ok: true, postId: uri, url: `https://bsky.app/profile/${s.handle}/post/${rkeyOf(uri)}` }
  },
  async stats(_conn, _creds, ref, ctx): Promise<Record<string, number>> {
    if (!ref.postId) return {}
    const res = await ctx.fetch(`${PUBLIC}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(ref.postId)}`, { method: 'GET', signal: timeoutSignal(15_000) })
    const data = await jsonOf(res)
    if (!res.ok) throw new PlatformError(`Bluesky: ${errText(data, res.status)}`, res.status)
    const p = (Array.isArray(data.posts) ? data.posts[0] : null) as Json | null
    if (!p) return {}
    return { likes: Number(p.likeCount ?? 0), shares: Number(p.repostCount ?? 0) + Number(p.quoteCount ?? 0), comments: Number(p.replyCount ?? 0) }
  },
  async followers(conn, _creds, ctx) {
    const actor = conn.ext?.did ?? conn.handle
    if (!actor) return null
    const res = await ctx.fetch(`${PUBLIC}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, { method: 'GET', signal: timeoutSignal(15_000) })
    const data = await jsonOf(res)
    return res.ok && typeof data.followersCount === 'number' ? data.followersCount : null
  },
}

export async function verifyBluesky(input: { identifier: string, password: string, url?: string | null }, f: FetchLike): Promise<{ creds: Creds, conn: Omit<SocialConn, 'id' | 'secret'> }> {
  const base = pds({ url: input.url })
  const s = await bskySession(base, input.identifier.replace(/^@/, ''), input.password, f)
  return { creds: { identifier: s.handle, password: input.password }, conn: { provider: 'bluesky', platform: 'bluesky', name: `@${s.handle}`, handle: s.handle, url: input.url || null, ext: { did: s.did } } }
}
