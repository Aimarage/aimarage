import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { config, isProduction } from './config'

export interface SitePage {
  url: string
  title: string | null
  description: string | null
  headings: string[]
  text: string
  image?: string | null
}

export interface SiteResult {
  url: string
  pages: SitePage[]
  error: string | null
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const SITE_UA = 'Aimarage/0.1 (+https://aimarage.com; Onboarding, nur lesend)'
const MAX_BYTES = 600_000
const PRIORITY = /(about|ueber|uber|über|pricing|preise|price|features|funktionen|faq|artists|kuenstler|künstler|so-funktioniert|how|warum|why)/i

function decode(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
}

function clean(s: string): string {
  return decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function parseHtml(html: string, url: string, opts: { maxText?: number, main?: boolean } = {}): SitePage & { links: string[], external: string[] } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const meta = (name: string) => new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)?.[1]
    ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i').exec(html)?.[1]
  const body = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const headings = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => clean(m[1]!)).filter(Boolean).slice(0, 20)
  const links: string[] = []
  const external: string[] = []
  const origin = new URL(url).origin
  for (const m of body.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(decode(m[1]!), url)
      if (/^https?:$/.test(u.protocol) && !/\.(png|jpe?g|gif|svg|pdf|zip|mp3|flac|wav|webp)$/i.test(u.pathname)) {
        u.hash = ''
        const list = u.origin === origin ? links : external
        if (!list.includes(u.href)) list.push(u.href)
      }
    }
    catch {}
  }
  const main = opts.main ? /<main[^>]*>([\s\S]*)<\/main>/i.exec(body)?.[1] : undefined
  return {
    url,
    title: title ? clean(title).slice(0, 200) : null,
    description: (meta('description') ?? meta('og:description')) ? decode((meta('description') ?? meta('og:description'))!).slice(0, 400) : null,
    headings,
    text: clean(main ?? body).slice(0, opts.maxText ?? 4000),
    image: absUrl(meta('og:image') ?? meta('og:image:url') ?? meta('twitter:image'), url),
    links,
    external,
  }
}

function absUrl(raw: string | undefined, base: string): string | null {
  if (!raw?.trim()) return null
  try {
    const u = new URL(decode(raw.trim()), base)
    return /^https?:$/.test(u.protocol) ? u.href : null
  }
  catch {
    return null
  }
}

const BLOCKED_V4: [number, number][] = [
  [0x00000000, 8],
  [0x0A000000, 8],
  [0x64400000, 10],
  [0x7F000000, 8],
  [0xA9FE0000, 16],
  [0xAC100000, 12],
  [0xC0000000, 24],
  [0xC0000200, 24],
  [0xC0586300, 24],
  [0xC0A80000, 16],
  [0xC6120000, 15],
  [0xC6336400, 24],
  [0xCB007100, 24],
  [0xE0000000, 4],
  [0xF0000000, 4],
]

function v4Number(ip: string): number | null {
  const p = ip.split('.')
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null
  return ((Number(p[0]) << 24) | (Number(p[1]) << 16) | (Number(p[2]) << 8) | Number(p[3])) >>> 0
}

function blockedV4(n: number): boolean {
  return BLOCKED_V4.some(([net, bits]) => ((n >>> (32 - bits)) << (32 - bits)) >>> 0 === net)
}

function v6Words(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '')
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (tail) {
    const n = v4Number(tail[1]!)
    if (n === null) return null
    s = `${s.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xFFFF).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const words = [...head, ...Array.from({ length: fill }, () => '0'), ...rest]
  if (words.length !== 8 || words.some(w => !/^[0-9a-f]{1,4}$/.test(w))) return null
  return words.map(w => Number.parseInt(w, 16))
}

export function isPrivateIp(ip: string): boolean {
  const v4 = v4Number(ip)
  if (v4 !== null) return blockedV4(v4)
  const w = v6Words(ip)
  if (!w) return true
  const embedded = (hi: number, lo: number) => blockedV4(((hi << 16) | lo) >>> 0)
  if (w.slice(0, 6).every(x => x === 0)) return w[6] === 0 || embedded(w[6]!, w[7]!)
  if (w.slice(0, 5).every(x => x === 0) && w[5] === 0xFFFF) return embedded(w[6]!, w[7]!)
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xFFFF && w[5] === 0) return embedded(w[6]!, w[7]!)
  if (w[0] === 0x64 && w[1] === 0xFF9B) return embedded(w[6]!, w[7]!)
  if (w[0] === 0x2002) return embedded(w[1]!, w[2]!)
  if ((w[0]! & 0xFE00) === 0xFC00) return true
  if ((w[0]! & 0xFFC0) === 0xFE80 || (w[0]! & 0xFFC0) === 0xFEC0) return true
  if ((w[0]! & 0xFF00) === 0xFF00) return true
  if (w[0] === 0x2001 && w[1] === 0x0DB8) return true
  if (w[0] === 0x2001 && w[1]! < 0x0200) return true
  return false
}

export function checksActive(): boolean {
  return isProduction || config.hosted || process.env.SITE_ALLOW_PRIVATE === 'false'
}

export async function assertPublicHost(url: string, opts: { force?: boolean } = {}): Promise<void> {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Nur http- und https-Adressen werden abgerufen')
  if (!opts.force && !checksActive()) return
  await assertPublicName(u.hostname)
}

export async function assertPublicName(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (!host || /^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error('Interne Adressen werden nicht abgerufen')
  let addrs: string[]
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map(a => a.address)
  }
  catch {
    throw new Error(`Adresse ${host} nicht gefunden`)
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('Interne Adressen werden nicht abgerufen')
}

export const MAIL_PORTS = { imap: [993, 143], smtp: [465, 587, 25] } as const

export async function assertMailServer(kind: 'imap' | 'smtp', host: string, port: number): Promise<void> {
  if (!checksActive()) return
  const label = kind === 'imap' ? 'IMAP' : 'SMTP'
  if (!(MAIL_PORTS[kind] as readonly number[]).includes(port)) throw new Error(`${label}-Port ${port} ist nicht erlaubt (${MAIL_PORTS[kind].join(', ')})`)
  try {
    await assertPublicName(host)
  }
  catch (err) {
    throw new Error(`${label}-Server ${host}: ${(err as Error).message}`)
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export async function safeFetch(url: string, init: RequestInit, fetchImpl: FetchLike = fetch, maxRedirects = 5): Promise<Response> {
  let current = url
  let req: RequestInit = { ...init, redirect: 'manual' }
  for (let hop = 0; ; hop++) {
    await assertPublicHost(current)
    const res = await fetchImpl(current, req)
    const location = REDIRECTS.has(res.status) ? res.headers.get('location') : null
    if (!location) {
      if (res.url !== current) Object.defineProperty(res, 'url', { value: current })
      return res
    }
    await res.body?.cancel().catch(() => {})
    if (hop >= maxRedirects) throw new Error('Zu viele Weiterleitungen')
    current = new URL(location, current).href
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && req.method && req.method !== 'GET' && req.method !== 'HEAD')) {
      req = { ...req, method: 'GET', body: undefined }
    }
  }
}

export async function getText(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<{ status: number, text: string, url: string, type: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await safeFetch(url, { method: 'GET', signal: ctrl.signal, headers: { 'User-Agent': SITE_UA, 'Accept': 'text/html,text/plain;q=0.9,*/*;q=0.5' } }, fetchImpl)
    const type = res.headers.get('content-type') ?? ''
    const reader = res.body?.getReader()
    let text = ''
    if (reader) {
      const dec = new TextDecoder()
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        text += dec.decode(value, { stream: true })
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    }
    else {
      text = (await res.text()).slice(0, MAX_BYTES)
    }
    return { status: res.status, text, url: res.url || url, type }
  }
  finally {
    clearTimeout(timer)
  }
}

export function robotsAllows(robots: string, path: string): boolean {
  let applies = false
  const disallow: string[] = []
  const allow: string[] = []
  for (const raw of robots.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const [k, ...rest] = line.split(':')
    const v = rest.join(':').trim()
    if (!k) continue
    const key = k.toLowerCase()
    if (key === 'user-agent') applies = v === '*' || /aimarage|marketingagent/i.test(v)
    else if (applies && key === 'disallow' && v) disallow.push(v)
    else if (applies && key === 'allow' && v) allow.push(v)
  }
  const longest = (list: string[]) => Math.max(-1, ...list.filter(p => path.startsWith(p.replace(/\*.*$/, ''))).map(p => p.length))
  return longest(allow) >= longest(disallow)
}

export async function fetchSite(url: string, opts: { maxPages?: number, timeoutMs?: number, fetchImpl?: FetchLike } = {}): Promise<SiteResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 8000
  const maxPages = opts.maxPages ?? 4
  let start: URL
  try {
    start = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
  }
  catch {
    return { url, pages: [], error: 'Ungültige Adresse' }
  }
  let robots = ''
  try {
    const r = await getText(`${start.origin}/robots.txt`, fetchImpl, 4000)
    if (r.status === 200 && !/html/i.test(r.type)) robots = r.text
  }
  catch {}
  const pages: SitePage[] = []
  let error: string | null = null
  try {
    if (!robotsAllows(robots, start.pathname)) return { url: start.href, pages, error: 'robots.txt erlaubt den Abruf nicht' }
    const first = await getText(start.href, fetchImpl, timeoutMs)
    if (first.status >= 400) return { url: start.href, pages, error: `HTTP ${first.status}` }
    const parsed = parseHtml(first.text, first.url)
    pages.push({ url: parsed.url, title: parsed.title, description: parsed.description, headings: parsed.headings, text: parsed.text, image: parsed.image })
    const candidates = parsed.links.filter(l => l !== parsed.url && PRIORITY.test(new URL(l).pathname)).slice(0, maxPages - 1)
    for (const link of candidates) {
      if (!robotsAllows(robots, new URL(link).pathname)) continue
      try {
        const r = await getText(link, fetchImpl, timeoutMs)
        if (r.status >= 400 || !/html/i.test(r.type || 'text/html')) continue
        const p = parseHtml(r.text, r.url)
        pages.push({ url: p.url, title: p.title, description: p.description, headings: p.headings, text: p.text.slice(0, 2500) })
      }
      catch {}
    }
  }
  catch (err) {
    error = (err as Error).name === 'AbortError' ? 'Zeitüberschreitung' : (err as Error).message.slice(0, 200)
  }
  return { url: start.href, pages, error }
}

export function siteDigest(site: SiteResult, max = 6000): string {
  const parts = site.pages.map(p => [`Seite: ${p.url}`, p.title ? `Titel: ${p.title}` : '', p.description ? `Beschreibung: ${p.description}` : '', p.headings.length ? `Überschriften: ${p.headings.join(' | ')}` : '', `Text: ${p.text}`].filter(Boolean).join('\n'))
  return parts.join('\n\n').slice(0, max)
}
