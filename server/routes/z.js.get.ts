import { COUNTER_SCRIPT } from '../lib/counter'

export default defineEventHandler((event) => {
  setHeader(event, 'Content-Type', 'text/javascript; charset=utf-8')
  setHeader(event, 'Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
  setHeader(event, 'Cross-Origin-Resource-Policy', 'cross-origin')
  setHeader(event, 'Access-Control-Allow-Origin', '*')
  return COUNTER_SCRIPT
})
