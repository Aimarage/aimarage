import { helpLang, helpMarkdownText } from '../lib/help'

const MD = /^\/(hilfe|en\/help)(?:\/([a-z0-9-]+))?\.md$/

export default defineEventHandler((event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') return
  const url = getRequestURL(event)
  const m = MD.exec(url.pathname)
  if (!m) return
  const text = helpMarkdownText(helpLang(m[1] === 'en/help' ? 'en' : url.searchParams.get('lang')), m[2])
  if (text === null) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  setHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
  setHeader(event, 'Cache-Control', 'public, max-age=300')
  return text
})
