import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { ProjectStats } from '../db/schema'
import { onSite, siteHosts } from '../../shared/utils/utm'
import { now, today } from './clock'
import type { Db } from './db'
import { schema } from './db'

// Aimarage-Zähler: z.js meldet Aufrufe mit utm-Parametern, /z zählt sie je Tag, Quelle, Medium, Kampagne, Inhalt und Pfad in utm_stats.
// Keine Cookies, keine IDs; IP und User-Agent nur flüchtig im Speicher für Rate-Limit und Bot-Filter.

export const SITE_RE = /^[A-Za-z0-9_-]{8,32}$/
export const MAX_BODY = 2048
const MAX_VALUE = 100
const MAX_PATH = 200
const CACHE_MS = 60_000
const LAST_HIT_MS = 5 * 60_000

export class CounterError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function newSiteId(): string {
  return randomBytes(9).toString('base64url')
}

export function buildCounterStats(cur: ProjectStats | null | undefined): ProjectStats {
  const was = cur?.mode === 'counter'
  return {
    mode: 'counter',
    url: '',
    site: cur?.site && SITE_RE.test(cur.site) ? cur.site : newSiteId(),
    campaignPrefix: null,
    secret: null,
    checkedAt: null,
    error: null,
    lastSync: was ? cur?.lastSync ?? null : null,
  }
}

export function counterSnippet(origin: string, site: string): string {
  return `<script defer src="${origin.replace(/\/+$/, '')}/z.js" data-site="${site}"></script>`
}

class MemoryLimiter {
  private hits = new Map<string, { n: number, reset: number }>()
  constructor(readonly max: number, readonly windowMs: number, readonly maxKeys = 50_000) {}

  hit(key: string, at = Date.now()): boolean {
    const cur = this.hits.get(key)
    if (!cur || cur.reset <= at) {
      if (this.hits.size >= this.maxKeys) this.prune(at)
      this.hits.set(key, { n: 1, reset: at + this.windowMs })
      return true
    }
    cur.n++
    return cur.n <= this.max
  }

  private prune(at: number) {
    for (const [k, v] of this.hits) if (v.reset <= at) this.hits.delete(k)
    if (this.hits.size >= this.maxKeys) this.hits.clear()
  }

  clear() {
    this.hits.clear()
  }
}

export const ipLimiter = new MemoryLimiter(30, 10 * 60_000)
export const siteLimiter = new MemoryLimiter(1200, 60_000, 10_000)

function ipKey(ip: string): string {
  return createHash('sha256').update(ip).digest('base64url').slice(0, 22)
}

const BOT_RE = /bot|crawl|spider|slurp|scrape|fetch|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|preview|monitor|uptime|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|httpclient|facebookexternalhit|embedly|whatsapp|telegram|discord|skype|slack/i

export function isBot(ua: string | null | undefined): boolean {
  const v = (ua ?? '').trim()
  return !v || v.length < 20 || BOT_RE.test(v)
}

function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u001F\u007F]+/g, '').trim().slice(0, max).trim()
}

export function cleanValue(v: unknown): string {
  return clean(v, MAX_VALUE).toLowerCase()
}

export function cleanPath(v: unknown): string {
  let p = clean(v, 1000).split(/[?#]/)[0]!.replace(/\s+/g, '')
  if (!p.startsWith('/')) p = '/'
  return p.slice(0, MAX_PATH)
}

export function cleanHost(v: unknown): string {
  const h = clean(v, 253).toLowerCase().replace(/^www\./, '')
  return /^[a-z0-9.-]+$/.test(h) && h.includes('.') ? h : ''
}

export interface Hit {
  site: string
  source: string
  medium: string
  campaign: string
  content: string
  path: string
  ref: string
}

export function parseHit(raw: string): Hit {
  if (raw.length > MAX_BODY) throw new CounterError(413, 'Zu groß')
  let b: Record<string, unknown>
  try {
    const x = JSON.parse(raw) as unknown
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('kein Objekt')
    b = x as Record<string, unknown>
  }
  catch {
    throw new CounterError(400, 'Kein JSON')
  }
  const site = typeof b.site === 'string' ? b.site : ''
  if (!SITE_RE.test(site)) throw new CounterError(404, 'Unbekannte Kennung')
  const hit: Hit = {
    site,
    source: cleanValue(b.source),
    medium: cleanValue(b.medium),
    campaign: cleanValue(b.campaign),
    content: cleanValue(b.content),
    path: cleanPath(b.path),
    ref: cleanHost(b.ref),
  }
  if (!hit.source && !hit.medium && !hit.campaign && !hit.content && !cleanValue(b.term)) throw new CounterError(400, 'Keine utm-Parameter')
  return hit
}

export interface CounterSite {
  projectId: string
  timezone: string
  hosts: string[]
}

const cache = new Map<string, { at: number, site: CounterSite | null }>()

export function clearCounterCache(): void {
  cache.clear()
}

export async function findCounterSite(db: Db, site: string, at = Date.now()): Promise<CounterSite | null> {
  const hit = cache.get(site)
  if (hit && at - hit.at < CACHE_MS) return hit.site
  const [row] = await db.select({ id: schema.projects.id, url: schema.projects.url, setup: schema.projects.setup, timezone: schema.workspaces.timezone })
    .from(schema.projects).innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.projects.workspaceId))
    .where(and(
      sql`${schema.projects.setup}->'stats'->>'site' = ${site}`,
      sql`${schema.projects.setup}->'stats'->>'mode' = 'counter'`,
      isNull(schema.projects.archivedAt),
      isNull(schema.workspaces.pausedAt),
      isNull(schema.workspaces.deletedAt),
    )).limit(1)
  const out = row ? { projectId: row.id, timezone: row.timezone, hosts: siteHosts([row.url, row.setup?.blog]) } : null
  if (cache.size > 5000) cache.clear()
  cache.set(site, { at, site: out })
  return out
}

export function originHost(origin: string | null | undefined, referer: string | null | undefined): string | null {
  for (const v of [origin, referer]) {
    if (!v || v === 'null') continue
    try {
      const u = new URL(v)
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString()
    }
    catch {}
  }
  return null
}

export function allowedOrigin(site: CounterSite, origin: string | null | undefined, referer: string | null | undefined): boolean {
  const from = originHost(origin, referer)
  return !!from && site.hosts.length > 0 && onSite(from, site.hosts)
}

const lastHits = new Map<string, number>()

async function markHit(db: Db, projectId: string, at: Date): Promise<void> {
  const prev = lastHits.get(projectId) ?? 0
  if (at.getTime() - prev < LAST_HIT_MS) return
  lastHits.set(projectId, at.getTime())
  await db.update(schema.projects)
    .set({ setup: sql`jsonb_set(${schema.projects.setup}, '{stats,lastSync}', to_jsonb(${at.toISOString()}::text))` })
    .where(and(eq(schema.projects.id, projectId), sql`${schema.projects.setup}->'stats'->>'mode' = 'counter'`))
}

export function resetCounter(): void {
  cache.clear()
  lastHits.clear()
  ipLimiter.clear()
  siteLimiter.clear()
}

export async function countHit(db: Db, site: CounterSite, hit: Hit, at = now()): Promise<void> {
  const ref = hit.ref && !onSite(`https://${hit.ref}`, site.hosts) ? hit.ref : ''
  const source = hit.source || ref || 'direkt'
  const day = today(site.timezone)
  await db.insert(schema.utmStats).values({ projectId: site.projectId, day, source, medium: hit.medium, campaign: hit.campaign, content: hit.content, path: hit.path, visits: 1, updatedAt: at })
    .onConflictDoUpdate({
      target: [schema.utmStats.projectId, schema.utmStats.day, schema.utmStats.source, schema.utmStats.medium, schema.utmStats.campaign, schema.utmStats.content, schema.utmStats.path],
      set: { visits: sql`${schema.utmStats.visits} + 1`, updatedAt: at },
    })
  await markHit(db, site.projectId, at)
}

export interface CounterRequest {
  body: string
  ip: string
  ua: string | null | undefined
  origin: string | null | undefined
  referer: string | null | undefined
}

export async function handleHit(db: Db, req: CounterRequest): Promise<void> {
  if (isBot(req.ua)) throw new CounterError(204, 'Bot')
  if (!ipLimiter.hit(ipKey(req.ip))) throw new CounterError(429, 'Zu viele Aufrufe')
  const hit = parseHit(req.body)
  const site = await findCounterSite(db, hit.site)
  if (!site) throw new CounterError(404, 'Unbekannte Kennung')
  if (!allowedOrigin(site, req.origin, req.referer)) throw new CounterError(403, 'Fremde Herkunft')
  if (!siteLimiter.hit(site.projectId)) throw new CounterError(429, 'Zu viele Aufrufe')
  await countHit(db, site, hit)
}

export const COUNTER_SCRIPT = `(function(){var d=document,n=navigator,l=location,h=history,s=d.currentScript,k=s&&s.getAttribute('data-site');if(!k||n.webdriver||!window.URLSearchParams)return;var e=new URL(s.src).origin+'/z',K=['source','medium','campaign','content','term'],seen={};function c(){var q=new URLSearchParams(l.search),o={site:k},f=0,i,v;for(i=0;i<5;i++){v=q.get('utm_'+K[i]);if(v){o[K[i]]=v.slice(0,200);f=1}}if(!f)return;var id=K.map(function(x){return o[x]||''}).join('|');if(seen[id])return;seen[id]=1;o.path=l.pathname.slice(0,300);try{o.ref=d.referrer?new URL(d.referrer).hostname:''}catch(x){}var b=JSON.stringify(o);try{if(window.fetch){fetch(e,{method:'POST',body:b,keepalive:true,credentials:'omit'})['catch'](function(){});return}}catch(x){}if(n.sendBeacon)n.sendBeacon(e,b)}function w(m){var o=h[m];if(o)h[m]=function(){var r=o.apply(this,arguments);try{c()}catch(x){}return r}}w('pushState');w('replaceState');addEventListener('popstate',c);c()})();
`
