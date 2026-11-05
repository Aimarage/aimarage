import { platformOf } from './drafting'
import { textFor } from './social'

export function utmSource(channel: string | null | undefined): string {
  const raw = (channel ?? '').split(',')[0]!.trim()
  const c = raw.toLowerCase()
  if (!c) return 'direkt'
  const p = platformOf({ channel: raw, targetUrl: null, title: '', category: '' })
  if (p && p !== 'reddit') return p
  return c.replace(/^reddit:r\//, 'reddit-').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'direkt'
}

export function buildUtmUrl(url: string | null | undefined, t: { channel?: string | null, category: string, code: string }): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  }
  catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.searchParams.set('utm_source', utmSource(t.channel))
  u.searchParams.set('utm_medium', t.category)
  u.searchParams.set('utm_campaign', t.code.toLowerCase())
  return u.toString()
}

export interface UtmTask {
  channel?: string | null
  category: string
  code: string
  title?: string
  targetUrl?: string | null
}

export function siteHost(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    return u.host.replace(/^www\./, '').toLowerCase() || null
  }
  catch {
    return null
  }
}

type Hosts = string | string[] | null | undefined
type Sites = string | (string | null | undefined)[] | null | undefined

export function onSite(url: string, host: Hosts): boolean {
  const h = siteHost(url)
  const list = Array.isArray(host) ? host : host ? [host] : []
  return !!h && list.some(x => h === x || h.endsWith(`.${x}`))
}

export function siteHosts(sites: Sites): string[] {
  const list = Array.isArray(sites) ? sites : [sites]
  return [...new Set(list.map(siteHost).filter((h): h is string => !!h))]
}

export function utmSites(p: { url?: string | null, setup?: { stats?: { url?: string | null } | null } | null } | null | undefined): string[] {
  return [p?.url, p?.setup?.stats?.url].filter((x): x is string => !!x)
}

export function utmSourceFor(t: UtmTask, platform?: string | null): string {
  if (platform && platform !== platformOf({ title: t.title ?? '', channel: t.channel, targetUrl: t.targetUrl, category: t.category })) return utmSource(platform)
  return utmSource(t.channel)
}

const LINK_RE = /https?:\/\/[^\s)>\]]+/g

export function splitUrl(m: string): [string, string] {
  const trail = m.match(/[.,;:!?'"]+$/)?.[0] ?? ''
  return [m.slice(0, m.length - trail.length), trail]
}

export function tagLinks(text: string, host: Hosts, utm: { source: string, medium: string, campaign: string }, opts: { keepSource?: boolean } = {}): string {
  if (!host?.length) return text
  return text.replace(LINK_RE, (m) => {
    const [raw, trail] = splitUrl(m)
    if (!onSite(raw, host)) return m
    let u: URL
    try {
      u = new URL(raw)
    }
    catch {
      return m
    }
    if (!opts.keepSource || !u.searchParams.get('utm_source')) u.searchParams.set('utm_source', utm.source)
    u.searchParams.set('utm_medium', utm.medium)
    u.searchParams.set('utm_campaign', utm.campaign)
    return u.toString() + trail
  })
}

export function siteLinks(text: string, host: Hosts): string[] {
  if (!host?.length) return []
  return [...text.matchAll(LINK_RE)].map(m => splitUrl(m[0])[0]).filter(u => onSite(u, host))
}

export function stripUtm(url: string): string {
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith('utm_')) u.searchParams.delete(k)
    }
    return u.toString()
  }
  catch {
    return url
  }
}

export function tagDraft<D extends { body: string, variants?: Record<string, string> | null }>(d: D, siteUrl: Sites, t: UtmTask): D {
  const host = siteHosts(siteUrl)
  if (!host.length || t.category !== 'social') return d
  const utm = (p?: string) => ({ source: utmSourceFor(t, p), medium: t.category, campaign: t.code.toLowerCase() })
  const variants = d.variants ? Object.fromEntries(Object.entries(d.variants).map(([p, v]) => [p, tagLinks(v, host, utm(p))])) : d.variants
  // Hat die Plattform des Kanals eine eigene Fassung, ist der Haupttext nicht ihr Text: seine Quelle bleibt, wie sie ist (beim Posten setzt postText sie je Plattform).
  const own = utmSource(t.channel)
  const fallback = !!d.variants?.[own]?.trim()
  return { ...d, body: tagLinks(d.body, host, utm(), { keepSource: fallback }), variants }
}

export function postText(platform: string, d: { body: string, variants?: Record<string, string> | null }, siteUrl: Sites, t: UtmTask): string {
  const text = textFor(platform, d.body, d.variants)
  if (t.category !== 'social') return text
  return tagLinks(text, siteHosts(siteUrl), { source: utmSourceFor(t, platform), medium: t.category, campaign: t.code.toLowerCase() })
}
