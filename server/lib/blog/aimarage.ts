import { call, json } from './http'
import { BlogApiError, BlogLangError, BlogRetryError, statusText, type BlogAdapter, type BlogTarget, type CallResult } from './types'

const ERRORS = { 401: 'Token abgelehnt, bitte neu eintragen', 403: 'Token abgelehnt, bitte neu eintragen', 404: 'Schnittstelle nicht gefunden oder abgeschaltet', 409: 'Diese Adresse (Slug) hat schon ein anderer Artikel', 413: 'Artikel zu groß für die Website', 500: 'Server konnte den Artikel nicht speichern, Schreibrechte prüfen' }

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, Authorization: `Bearer ${token}` }
}

export function apiPath(t: Pick<BlogTarget, 'url'>, sub: string, query: Record<string, string> = {}): string {
  const u = new URL(t.url)
  if (sub) u.pathname = `${u.pathname.replace(/\/+$/, '')}/${sub}`
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
  return u.toString()
}

function fields(r: CallResult): string[] {
  return Array.isArray(r.body?.fields) ? (r.body!.fields as unknown[]).map(String) : []
}

function retry(r: CallResult): void {
  if (r.status === 429) throw new BlogRetryError(Math.max(1, Math.min(r.retryAfter ?? 60, 24 * 3600)))
}

export const aimarageBlog: BlogAdapter = {
  type: 'aimarage',
  multiLang: true,
  async check(t, token, fetchImpl) {
    const list = await call(t.url, { method: 'GET', headers: auth(token) }, token, fetchImpl)
    if (list.status === 200 && list.body?.ok === true) return
    if ([401, 403, 404, 429].includes(list.status)) throw new BlogApiError(statusText(list.status, ERRORS))
    const probe = json({})
    const r = await call(t.url, { method: 'POST', body: probe.body, headers: auth(token, probe.headers) }, token, fetchImpl)
    if (r.status !== 422) throw new BlogApiError(statusText(r.status, ERRORS))
  },
  async publish(t, token, a, fetchImpl) {
    const image = a.imageUrl ?? undefined
    const j = json({ key: a.key, lang: a.lang, slug: a.slug, title: a.title, description: a.description, ...(a.date ? { date: a.date } : {}), updated: a.updated, ...(image ? { image } : {}), ...(a.aiGenerated ? { ai_generated: true } : {}), body: a.body })
    const r = await call(t.url, { method: 'POST', body: j.body, headers: auth(token, j.headers) }, token, fetchImpl)
    retry(r)
    if (r.status === 422) {
      const f = fields(r)
      if (f.includes('lang')) throw new BlogLangError(a.lang)
      throw new BlogApiError(`Felder ungültig${f.length ? `: ${f.join(', ')}` : ''} (422)`)
    }
    if (r.status !== 200 && r.status !== 201) throw new BlogApiError(statusText(r.status, ERRORS))
    const url = r.body?.url
    if (!r.body?.ok || typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new BlogApiError('Antwort ohne Adresse des Artikels')
    return { url }
  },
  async uploadImage(t, token, img, fetchImpl) {
    const r = await call(apiPath(t, 'images', { name: img.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'bild' }), { method: 'POST', headers: auth(token, { 'Content-Type': img.mime }), body: img.data as unknown as BodyInit }, token, fetchImpl)
    retry(r)
    if (r.status === 413) throw new BlogApiError('Bild zu groß für die Website (413)')
    if (r.status === 415) throw new BlogApiError('Bildformat wird nicht angenommen, nur JPEG, PNG, WebP oder GIF (415)')
    if (r.status !== 200 && r.status !== 201) throw new BlogApiError(`Bild: ${statusText(r.status, ERRORS)}`)
    const path = r.body?.path
    const url = r.body?.url
    if (typeof path === 'string' && /^\/[\w./-]+$/.test(path)) return path
    if (typeof url === 'string' && /^https:\/\//.test(url)) return url
    throw new BlogApiError('Bild: Antwort ohne Adresse')
  },
  async withdraw(t, token, postedUrl, fetchImpl) {
    const list = await call(t.url, { method: 'GET', headers: auth(token) }, token, fetchImpl)
    retry(list)
    let key: string | null = null
    if (list.status === 200 && Array.isArray(list.body?.articles)) {
      const row = (list.body!.articles as { key?: unknown, url?: unknown }[]).find(a => a.url === postedUrl)
      if (row && typeof row.key === 'string') key = row.key
      else return { deleted: false }
    }
    else if ([401, 403].includes(list.status)) throw new BlogApiError(statusText(list.status, ERRORS))
    key ??= new URL(postedUrl).pathname.split('/').filter(Boolean).pop() ?? null
    if (!key || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) throw new BlogApiError('Artikel auf der Website nicht gefunden')
    const r = await call(apiPath(t, '', { key }), { method: 'DELETE', headers: auth(token) }, token, fetchImpl)
    retry(r)
    if (r.status === 404 && r.body?.error === 'not found') return { deleted: false }
    if (r.status !== 200) throw new BlogApiError(statusText(r.status, { ...ERRORS, 405: 'Website kann Artikel nicht zurückziehen' }))
    return { deleted: true }
  },
}
