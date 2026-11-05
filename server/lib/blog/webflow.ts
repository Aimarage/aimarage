import { markdownToHtml } from '../../../shared/utils/markdown'
import { call, json } from './http'
import { BlogApiError, statusText, type BlogAdapter, type BlogTarget } from './types'

export const WEBFLOW_API = 'https://api.webflow.com/v2'
const ERRORS = { 401: 'Site-Token abgelehnt', 403: 'Site-Token hat keine CMS-Rechte (CMS: Lesen und Schreiben)', 404: 'Collection nicht gefunden (Collection-ID prüfen)' }

function base(t: BlogTarget): string {
  if (!t.collectionId) throw new BlogApiError('Collection-ID fehlt')
  return `${WEBFLOW_API}/collections/${encodeURIComponent(t.collectionId)}`
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export function webflowFields(t: BlogTarget): { title: string, slug: string, body: string, description: string | null } {
  return { title: t.fields?.title || 'name', slug: t.fields?.slug || 'slug', body: t.fields?.body || 'post-body', description: t.fields?.description || null }
}

export const webflowBlog: BlogAdapter = {
  type: 'webflow',
  multiLang: false,
  async check(t, token, fetchImpl) {
    const r = await call(base(t), { method: 'GET', headers: auth(token) }, token, fetchImpl)
    if (r.status !== 200) throw new BlogApiError(statusText(r.status, ERRORS))
  },
  async publish(t, token, a, fetchImpl) {
    const b = base(t)
    const f = webflowFields(t)
    const found = await call(`${b}/items?slug=${encodeURIComponent(a.slug)}`, { method: 'GET', headers: auth(token) }, token, fetchImpl)
    if (found.status !== 200) throw new BlogApiError(statusText(found.status, ERRORS))
    const existing = (found.body?.items as { id?: string }[] | undefined)?.[0]?.id ?? null
    const fieldData: Record<string, string> = { [f.title]: a.title, [f.slug]: a.slug, [f.body]: markdownToHtml(a.body) }
    if (f.description) fieldData[f.description] = a.description
    const j = json({ isArchived: false, isDraft: t.status === 'draft', fieldData })
    const saved = await call(existing ? `${b}/items/${existing}` : `${b}/items`, { method: existing ? 'PATCH' : 'POST', headers: { ...auth(token), ...j.headers }, body: j.body }, token, fetchImpl)
    if (saved.status !== 200 && saved.status !== 202) throw new BlogApiError(`${statusText(saved.status, ERRORS)}${saved.body?.message ? `: ${String(saved.body.message).slice(0, 200)}` : ''}`)
    const id = typeof saved.body?.id === 'string' ? saved.body.id : existing
    if (!id) throw new BlogApiError('Antwort ohne Item-ID')
    if (t.status !== 'draft') {
      const p = json({ itemIds: [id] })
      const pub = await call(`${b}/items/publish`, { method: 'POST', headers: { ...auth(token), ...p.headers }, body: p.body }, token, fetchImpl)
      if (pub.status !== 200 && pub.status !== 202) throw new BlogApiError(`Gespeichert, aber nicht veröffentlicht: ${statusText(pub.status, ERRORS)}`)
    }
    return { url: `${t.url.replace(/\/+$/, '')}/${a.slug}` }
  },
}
