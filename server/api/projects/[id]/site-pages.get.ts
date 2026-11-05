import { projectPages } from '~~/server/lib/site-pages'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event)
  const rows = await projectPages(db, p.id)
  const host = p.url ? (() => {
    try {
      return new URL(p.url!).host
    }
    catch {
      return null
    }
  })() : null
  return {
    url: p.url,
    fetchedAt: rows.length ? new Date(Math.max(...rows.map(r => r.fetchedAt.getTime()))).toISOString() : null,
    pages: rows.map(r => ({ url: r.url, title: r.title, chars: r.text.length, linked: !!host && new URL(r.url).host !== host })),
  }
})
