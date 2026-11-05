export const ARTICLE_LANGS = ['de', 'en'] as const

export function isLangKey(k: string): boolean {
  return (ARTICLE_LANGS as readonly string[]).includes(k)
}

export function articleSlug(text: string, max = 80): string {
  const s = text.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  return (cut.lastIndexOf('-') > max / 2 ? cut.slice(0, cut.lastIndexOf('-')) : cut).replace(/-+$/, '')
}

export function splitTitle(text: string, fallback: string | null): { title: string, body: string } {
  const t = text.replace(/\r\n/g, '\n').trim()
  const m = /^#\s+(.+)\n+/.exec(t)
  if (m) return { title: m[1]!.trim(), body: t.slice(m[0].length).trim() }
  return { title: (fallback ?? '').trim(), body: t }
}

export function articleDescription(body: string, max = 160): string {
  const para = body.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !/^(#|[-*]\s|\d+\.\s|>)/.test(p)) ?? ''
  const plain = para.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > max / 2 ? cut.lastIndexOf(' ') : cut.length).replace(/[,;:.\s]+$/, '')}…`
}

export function fallbackDescription(body: string, title: string, max = 160): string {
  const d = articleDescription(body, max)
  if (d) return d
  const line = body.split('\n').map(l => l.replace(/^\s*(#+|[-*]|\d+\.|>)\s*/, '').trim()).find(Boolean) ?? ''
  return articleDescription(line, max) || articleDescription(title, max)
}

export interface ArticleVersion {
  lang: string
  title: string
  description: string
  body: string
  slug: string
}

export function articleVersions(draft: { subject: string | null, body: string, variants?: Record<string, string> | null }, mainLang: string, fallbackTitle: string): ArticleVersion[] {
  const main = splitTitle(draft.body, draft.subject || fallbackTitle)
  const out: ArticleVersion[] = [{ lang: mainLang, title: draft.subject?.trim() || main.title, body: main.body, description: fallbackDescription(main.body, draft.subject?.trim() || main.title), slug: articleSlug(draft.subject?.trim() || main.title) }]
  for (const [k, v] of Object.entries(draft.variants ?? {})) {
    if (!isLangKey(k) || k === mainLang || !v.trim()) continue
    const x = splitTitle(v, null)
    if (!x.title || !x.body) continue
    out.push({ lang: k, title: x.title, body: x.body, description: fallbackDescription(x.body, x.title), slug: articleSlug(x.title) })
  }
  return out.filter(a => a.title && a.body && a.slug)
}
