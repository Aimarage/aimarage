import type { PostPlatformResult } from '../db/schema'
import { redactKey } from './llm'
import { looksHtml, statusText } from './platforms/types'
import type { FetchLike, OutletMedia, PostOutcome, PostRequest, PostStat, SocialOutlet } from './outlets'
import { registerOutlet } from './outlets'
import { SOCIAL_PROVIDERS, type SocialConfig } from './social'

const BASE = SOCIAL_PROVIDERS.uploadpost.baseUrl

type Json = Record<string, unknown>

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

export class OutletError extends Error {
  constructor(message: string, public status: number, public code: string | null = null) {
    super(message)
  }
}

async function call(cfg: SocialConfig, path: string, init: { method: 'GET' | 'POST', body?: FormData }, fetchImpl: FetchLike = fetch, timeoutMs = 60_000): Promise<Json> {
  if (!cfg.apiKey) throw new OutletError('Kein Schlüssel für Upload-Post hinterlegt', 0, 'no_key')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${BASE}${path}`, { method: init.method, headers: { Authorization: `Apikey ${cfg.apiKey}`, Accept: 'application/json' }, body: init.body, signal: ctrl.signal })
    const text = await res.text().catch(() => '')
    let data: Json = {}
    try {
      data = text ? JSON.parse(text) as Json : {}
    }
    catch {
      data = looksHtml(text) ? {} : { message: text.slice(0, 300) }
    }
    if (!res.ok && res.status !== 202) {
      const msg = res.status >= 500 ? statusText(res.status) : str(data.message) ?? str(data.error) ?? statusText(res.status)
      throw new OutletError(redactKey(`${res.status === 401 ? 'Schlüssel abgelehnt' : res.status === 429 ? 'Limit erreicht' : 'Upload-Post'}: ${msg}`, cfg.apiKey).slice(0, 400), res.status, str(data.error_code))
    }
    return data
  }
  catch (err) {
    if (err instanceof OutletError) throw err
    throw new OutletError(redactKey(`Upload-Post nicht erreichbar: ${(err as Error).message}`, cfg.apiKey).slice(0, 300), 0, 'network')
  }
  finally {
    clearTimeout(timer)
  }
}

export function endpointFor(media: { mime: string }[]): '/upload' | '/upload_photos' | '/upload_text' {
  if (media.some(m => m.mime.startsWith('video/'))) return '/upload'
  if (media.length) return '/upload_photos'
  return '/upload_text'
}

function localDate(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`
}

export function buildForm(req: PostRequest): FormData {
  const f = new FormData()
  const path = endpointFor(req.media)
  f.append('user', req.profile)
  for (const p of req.platforms) f.append('platform[]', p)
  const textOf = (p: string) => req.variants[p]?.trim() ? req.variants[p]! : req.text
  const video = req.media.find(m => m.mime.startsWith('video/'))
  if (path === '/upload') {
    const firstLine = (req.variants.youtube || req.text).split('\n').find(l => l.trim())?.trim() ?? ''
    f.append('title', req.platforms.includes('youtube') ? [...firstLine].slice(0, 100).join('') : req.text)
    f.append('description', req.text)
    f.append('video', blob(video!), video!.name)
  }
  else {
    f.append('title', req.text)
    if (path === '/upload_photos') {
      f.append('description', req.text)
      for (const m of req.media) f.append('photos[]', blob(m), m.name)
    }
  }
  for (const p of req.platforms) {
    const t = textOf(p)
    if (p === 'youtube') {
      if (path === '/upload') f.append('youtube_description', t)
      continue
    }
    if (t !== req.text) f.append(`${p}_title`, t)
    if (p === 'linkedin' && path !== '/upload_text') f.append('linkedin_description', t)
    if (p === 'facebook' && path === '/upload') f.append('facebook_description', t)
    if (p === 'tiktok' && path === '/upload_photos') f.append('tiktok_description', t)
  }
  if (req.aiGenerated && path === '/upload') {
    if (req.platforms.includes('tiktok')) f.append('is_aigc', 'true')
    if (req.platforms.includes('youtube')) f.append('containsSyntheticMedia', 'true')
  }
  if (req.at) {
    f.append('scheduled_date', localDate(req.at, req.timezone))
    f.append('timezone', req.timezone)
  }
  f.append('async_upload', 'true')
  f.append('external_id', req.externalId)
  return f
}

function blob(m: OutletMedia): Blob {
  return new Blob([m.data as unknown as ArrayBuffer], { type: m.mime })
}

function platformResults(raw: unknown, platforms: string[]): PostPlatformResult[] {
  const out: PostPlatformResult[] = []
  if (Array.isArray(raw)) {
    for (const r of raw as Json[]) {
      const p = str(r.platform)
      if (!p) continue
      const st = str(r.status)
      const ok = r.success === true && (!st || st === 'completed') ? true : r.success === false || st === 'failed' || st === 'skipped' || r.skipped === true ? false : null
      out.push({ platform: p, ok, url: str(r.post_url ?? r.url), postId: str(r.platform_post_id ?? r.post_id), error: ok === false ? str(r.error ?? r.error_message ?? r.message ?? r.skip_reason) : null })
    }
  }
  else if (raw && typeof raw === 'object') {
    for (const [p, v] of Object.entries(raw as Json)) {
      const r = (v ?? {}) as Json
      const ok = r.success === true ? (r.fallback_to_inbox ? false : true) : false
      out.push({ platform: p, ok, url: str(r.url ?? r.post_url), postId: str(r.post_id ?? r.publish_id ?? r.video_id ?? r.container_id), error: ok ? null : r.fallback_to_inbox ? 'Nur als Entwurf in der App gelandet' : str(r.error ?? r.message ?? r.skip_reason) ?? 'fehlgeschlagen' })
    }
  }
  for (const p of platforms) if (!out.some(o => o.platform === p)) out.push({ platform: p, ok: null })
  return out
}

export function outcomeOf(data: Json, platforms: string[]): PostOutcome {
  const requestId = str(data.request_id) ?? str(data.job_id)
  if (data.results !== undefined && !Array.isArray(data.results)) {
    const results = platformResults(data.results, platforms)
    const anyOk = results.some(r => r.ok)
    return { state: anyOk ? 'done' : 'failed', requestId, results, error: anyOk ? null : results.map(r => r.error).filter(Boolean).join('; ') || 'fehlgeschlagen' }
  }
  const status = str(data.status)
  const results = platformResults(data.results, platforms)
  if (status === 'completed') {
    const anyOk = results.some(r => r.ok)
    return { state: anyOk ? 'done' : 'failed', requestId, results, error: anyOk ? null : results.map(r => r.error).filter(Boolean).join('; ') || 'fehlgeschlagen' }
  }
  if (status === 'failed' || status === 'not_found') return { state: 'failed', requestId, results, error: str(data.message) ?? str(data.error) ?? (status === 'not_found' ? 'Upload bei Upload-Post nicht gefunden' : 'fehlgeschlagen') }
  if (data.job_id && data.scheduled_date) return { state: 'scheduled', requestId, results, error: null }
  return { state: 'pending', requestId, results, error: null }
}

async function fillUrls(cfg: SocialConfig, out: PostOutcome, fetchImpl?: FetchLike): Promise<PostOutcome> {
  if (!out.requestId || out.results.every(r => !r.ok || r.url)) return out
  try {
    const h = await call(cfg, `/uploadposts/history?request_id=${encodeURIComponent(out.requestId)}&limit=20`, { method: 'GET' }, fetchImpl, 20_000)
    const items = Array.isArray(h.history) ? h.history as Json[] : []
    for (const r of out.results) {
      const it = items.find(i => i.platform === r.platform && i.success !== false)
      if (it && !r.url) r.url = str(it.post_url)
      if (it && !r.postId) r.postId = str(it.platform_post_id)
    }
  }
  catch {
    return out
  }
  return out
}

const METRIC_KEYS: Record<string, string> = { views: 'views', impressions: 'reach', reach: 'reach', likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves', clicks: 'clicks', link_clicks: 'clicks', outbound_clicks: 'clicks', pin_clicks: 'clicks', reposts: 'shares', retweets: 'shares', favorites: 'likes' }

export function normMetrics(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Json)) {
    const key = METRIC_KEYS[k]
    const n = num(v)
    if (!key || n === null) continue
    out[key] = Math.max(out[key] ?? 0, n)
  }
  return out
}

export const uploadPostOutlet: SocialOutlet = {
  id: 'uploadpost',
  label: 'Upload-Post',
  async post(cfg, req, fetchImpl) {
    const data = await call(cfg, endpointFor(req.media), { method: 'POST', body: buildForm(req) }, fetchImpl, 180_000)
    const out = outcomeOf(data, req.platforms)
    return out.state === 'done' ? fillUrls(cfg, out, fetchImpl) : out
  },
  async status(cfg, requestId, fetchImpl) {
    const data = await call(cfg, `/uploadposts/status?request_id=${encodeURIComponent(requestId)}`, { method: 'GET' }, fetchImpl, 20_000).catch((err) => {
      if (err instanceof OutletError && err.status === 404) return { status: 'not_found' } as Json
      throw err
    })
    const out = outcomeOf({ ...data, request_id: requestId }, [])
    return out.state === 'done' ? fillUrls(cfg, out, fetchImpl) : out
  },
  async stats(cfg, requestId, fetchImpl) {
    const data = await call(cfg, `/uploadposts/post-analytics/${encodeURIComponent(requestId)}`, { method: 'GET' }, fetchImpl, 30_000)
    const plats = (data.platforms ?? {}) as Json
    return Object.entries(plats).map(([platform, v]) => {
      const r = (v ?? {}) as Json
      return { platform, url: str(r.post_url), metrics: normMetrics(r.post_metrics) }
    })
  },
  async profileStats(cfg, profile, platforms, fetchImpl) {
    const list = platforms.filter(p => ['instagram', 'tiktok', 'linkedin', 'facebook', 'x', 'youtube', 'threads', 'pinterest', 'bluesky'].includes(p))
    if (!list.length) return {}
    const data = await call(cfg, `/analytics/${encodeURIComponent(profile)}?platforms=${encodeURIComponent(list.join(','))}`, { method: 'GET' }, fetchImpl, 30_000)
    const out: Record<string, Record<string, number>> = {}
    for (const p of list) {
      const r = (data[p] ?? {}) as Json
      const m = normMetrics(r)
      const f = num(r.followers)
      if (f !== null) m.followers = f
      if (Object.keys(m).length) out[p] = m
    }
    return out
  },
}

registerOutlet(uploadPostOutlet)
