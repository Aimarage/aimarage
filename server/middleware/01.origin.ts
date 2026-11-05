export default defineEventHandler((event) => {
  const method = event.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const path = event.path
  if (!path.startsWith('/api/') || path.startsWith('/api/v1/') || path === '/api/v1') return
  if (getHeader(event, 'sec-fetch-site') === 'cross-site') throw createError({ statusCode: 403, statusMessage: 'Fremde Herkunft' })
  const origin = getHeader(event, 'origin')
  if (!origin || origin === 'null') return
  let host = ''
  try {
    host = new URL(origin).host
  }
  catch {
    throw createError({ statusCode: 403, statusMessage: 'Fremde Herkunft' })
  }
  const own = getHeader(event, 'x-forwarded-host') ?? getHeader(event, 'host')
  if (host !== own) throw createError({ statusCode: 403, statusMessage: 'Fremde Herkunft' })
})
