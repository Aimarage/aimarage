import type { PostPlatformResult } from '../../db/schema'
import type { FetchLike, OutletMedia } from '../outlets'

export type OwnProvider = 'bluesky' | 'mastodon' | 'meta' | 'instagram' | 'threads' | 'linkedin' | 'x' | 'tiktok' | 'telegram' | 'youtube'

export interface StoredSecret {
  enc: string
  hint: string
  setAt: string
}

export interface SocialConn {
  id: string
  provider: OwnProvider
  platform: string
  name: string
  handle?: string | null
  url?: string | null
  ext?: Record<string, string>
  secret: StoredSecret
  expiresAt?: string | null
  checkedAt?: string | null
  error?: string | null
}

export interface OAuthApp {
  clientId: string
  secret?: StoredSecret
  redirectUri?: string | null
  user?: string | null
  key?: StoredSecret
}

export type Creds = Record<string, string>

export interface AdapterCtx {
  fetch: FetchLike
  sleep?: (ms: number) => Promise<void>
  saveCreds: (c: Creds, expiresAt?: string | null) => Promise<void>
  app?: { clientId: string, clientSecret: string, redirectUri: string } | null
}

export interface AdapterPost {
  text: string
  media: OutletMedia[]
  link: string | null
  title?: string | null
  aiGenerated?: boolean
}

export interface PlatformAdapter {
  provider: OwnProvider
  label: string
  platforms: string[]
  post: (conn: SocialConn, creds: Creds, req: AdapterPost, ctx: AdapterCtx) => Promise<PostPlatformResult>
  stats?: (conn: SocialConn, creds: Creds, ref: { postId: string | null, url: string | null }, ctx: AdapterCtx) => Promise<Record<string, number>>
  followers?: (conn: SocialConn, creds: Creds, ctx: AdapterCtx) => Promise<number | null>
  refresh?: (conn: SocialConn, creds: Creds, ctx: AdapterCtx) => Promise<boolean>
}

export class PlatformError extends Error {
  constructor(message: string, public status = 0) {
    super(message)
  }
}

export async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '')
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {}
  }
  catch {
    return looksHtml(text) ? {} : { message: text.slice(0, 300) }
  }
}

// HTML-Fehlerseiten (z.B. 503 vom Proxy) gehören nie in eine Fehlermeldung.
export function looksHtml(text: string): boolean {
  return /^\s*<(?:!doctype|html|head|body|\?xml)|<\/?(?:html|head|body|title|div|meta)[\s>]/i.test(text)
}

// Kurze Klartext-Erklärung zum HTTP-Status, 5xx und 429 sind vorübergehend.
export function statusText(status: number): string {
  if (status === 429) return 'zu viele Anfragen, wird später erneut versucht (429)'
  if (status >= 500) return `Server vorübergehend nicht erreichbar (${status})`
  return `HTTP ${status}`
}

export function errText(data: Record<string, unknown>, status: number): string {
  const e = data.error
  const inner = e && typeof e === 'object' ? (e as Record<string, unknown>).message ?? (e as Record<string, unknown>).error_user_msg : e
  const msg = [data.message, data.error_message, data.error_description, inner, data.detail, data.title].find(v => typeof v === 'string' && v && !looksHtml(v))
  if (status >= 500 || status === 429) return statusText(status)
  return `HTTP ${status}${msg ? `: ${String(msg).slice(0, 300)}` : ''}`
}

// Gespeicherte Fehlermeldung ohne HTML: "Mastodon: HTTP 503: <!DOCTYPE ..." wird "Mastodon: Server vorübergehend nicht erreichbar (503)".
export function cleanError(message: string): string {
  const m = /^(.*?)HTTP (\d{3})\b/.exec(message)
  if (m && (Number(m[2]) >= 500 || Number(m[2]) === 429)) return `${m[1]}${statusText(Number(m[2]))}`
  if (!looksHtml(message)) return message
  const cut = message.search(/<|&lt;/)
  return (m ? `${m[1]}${statusText(Number(m[2]))}` : message.slice(0, cut).replace(/[:\s]+$/, '')) || 'Server vorübergehend nicht erreichbar'
}

export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

export function bytesLength(s: string): number {
  return new TextEncoder().encode(s).length
}

export function firstUrl(text: string): string | null {
  return /https?:\/\/[^\s)>\]]+/.exec(text)?.[0]?.replace(/[.,;:!?]+$/, '') ?? null
}

export async function callJson(f: FetchLike, label: string, url: string, init: RequestInit = {}, ms = 30_000): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await f(url, { method: 'GET', ...init, signal: timeoutSignal(ms) })
  }
  catch (err) {
    throw new PlatformError(`${label}: nicht erreichbar (${(err as Error).message.replace(/\?[^\s)]*/g, '').slice(0, 120)})`)
  }
  const data = await jsonOf(res)
  if (!res.ok) throw new PlatformError(`${label}: ${errText(data, res.status)}`, res.status)
  return data
}

export function form(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params)
}

export function wait(ctx: { sleep?: (ms: number) => Promise<void> }, ms: number): Promise<void> {
  return ctx.sleep ? ctx.sleep(ms) : new Promise(r => setTimeout(r, ms))
}
