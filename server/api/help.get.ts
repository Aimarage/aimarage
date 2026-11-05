import { helpLang, helpPage } from '~~/server/lib/help'

const query = z.object({ lang: z.string().max(5).optional() })

export default defineEventHandler((event) => {
  const q = parseQuery(event, query)
  setHeader(event, 'Cache-Control', 'public, max-age=300')
  return helpPage(helpLang(q.lang))
})
