import { openFile } from '~~/server/lib/media'
import { openMediaLink } from '~~/server/lib/media-link'

// Öffentliche Medien-Links für Instagram, Threads und Co. Auch mit S3-Ablage streamt die App
// die Datei selbst durch (kein Redirect auf presigned URLs): Die URL bleibt stabil, HEAD und
// Content-Type kommen von uns, der Bucket bleibt privat und muss von außen nicht erreichbar sein.
export default defineEventHandler(async (event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') throw createError({ statusCode: 405 })
  const link = openMediaLink(getRouterParam(event, 'name') ?? '')
  if (!link) throw createError({ statusCode: 404 })
  const file = await openFile(link.file)
  if (!file) throw createError({ statusCode: 404 })
  setHeader(event, 'Content-Type', link.mime)
  setHeader(event, 'Content-Length', file.size)
  setHeader(event, 'Cache-Control', 'public, max-age=3600')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'X-Robots-Tag', 'noindex')
  if (event.method === 'HEAD') {
    event.node.res.statusCode = 200
    event.node.res.end()
    return
  }
  return sendStream(event, await file.stream())
})
