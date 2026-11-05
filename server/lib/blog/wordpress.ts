import { markdownToHtml } from '../../../shared/utils/markdown'
import { call, json } from './http'
import { BlogApiError, statusText, type BlogAdapter, type BlogTarget } from './types'

const ERRORS = { 401: 'Benutzername oder Anwendungspasswort falsch', 403: 'Benutzer darf keine Beiträge veröffentlichen', 404: 'WordPress-Schnittstelle nicht gefunden (Adresse prüfen)' }

function api(t: BlogTarget): string {
  return `${t.url.replace(/\/+$/, '')}/wp-json/wp/v2`
}

function auth(t: BlogTarget, password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${t.user ?? ''}:${password}`).toString('base64')}` }
}

export const wordpressBlog: BlogAdapter = {
  type: 'wordpress',
  multiLang: false,
  async check(t, password, fetchImpl) {
    if (!t.user) throw new BlogApiError('Benutzername fehlt')
    const r = await call(`${api(t)}/users/me?context=edit`, { method: 'GET', headers: auth(t, password) }, password, fetchImpl)
    if (r.status !== 200) throw new BlogApiError(statusText(r.status, ERRORS))
  },
  async publish(t, password, a, fetchImpl) {
    if (!t.user) throw new BlogApiError('Benutzername fehlt')
    const h = auth(t, password)
    const found = await call(`${api(t)}/posts?slug=${encodeURIComponent(a.slug)}&status=publish,draft,future,pending,private&context=edit`, { method: 'GET', headers: h }, password, fetchImpl)
    if (found.status !== 200) throw new BlogApiError(statusText(found.status, ERRORS))
    const existing = Array.isArray(found.body) ? (found.body as { id?: number }[])[0]?.id ?? null : null
    let media: number | null = null
    if (a.image) {
      const up = await call(`${api(t)}/media`, { method: 'POST', headers: { ...h, 'Content-Type': a.image.mime, 'Content-Disposition': `attachment; filename="${a.image.name.replace(/[^\w.-]/g, '_')}"` }, body: a.image.data as unknown as BodyInit }, password, fetchImpl)
      if (up.status === 201 && typeof up.body?.id === 'number') media = up.body.id
    }
    const post = { title: a.title, content: markdownToHtml(a.body), excerpt: a.description, slug: a.slug, status: t.status ?? 'publish', ...(t.category ? { categories: [t.category] } : {}), ...(media ? { featured_media: media } : {}) }
    const j = json(post)
    const r = await call(existing ? `${api(t)}/posts/${existing}` : `${api(t)}/posts`, { method: 'POST', headers: { ...h, ...j.headers }, body: j.body }, password, fetchImpl)
    if (r.status !== 200 && r.status !== 201) throw new BlogApiError(statusText(r.status, ERRORS))
    const url = r.body?.link
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new BlogApiError('Antwort ohne Adresse des Beitrags')
    return { url }
  },
}
