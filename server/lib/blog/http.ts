import { redactKey } from '../llm'
import { assertPublicHost, SITE_UA } from '../site'
import { BlogApiError, type CallResult, type FetchLike } from './types'

export async function call(url: string, init: { method: string, headers?: Record<string, string>, body?: BodyInit | null }, secret: string, fetchImpl: FetchLike, timeoutMs = 30_000): Promise<CallResult> {
  await assertPublicHost(url)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: init.method, redirect: 'error', signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': SITE_UA, ...init.headers }, body: init.body ?? undefined })
    let body: Record<string, unknown> | null = null
    try {
      const j = await res.json()
      body = j && typeof j === 'object' ? j as Record<string, unknown> : null
    }
    catch {
      body = null
    }
    return { status: res.status, body, retryAfter: retryAfter(res.headers.get('retry-after')) }
  }
  catch (err) {
    const e = err as Error
    throw new BlogApiError(redactKey(e.name === 'AbortError' ? 'Zeitüberschreitung' : `Abruf fehlgeschlagen: ${e.message}`, secret).slice(0, 300))
  }
  finally {
    clearTimeout(timer)
  }
}

export function json(body: unknown): { body: string, headers: Record<string, string> } {
  return { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
}

export function retryAfter(v: string | null): number | null {
  if (!v) return null
  if (/^\d+$/.test(v.trim())) return Number(v.trim())
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : Math.max(0, Math.round((t - Date.now()) / 1000))
}
