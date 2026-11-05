import { apiCors, siteBase } from '~~/server/lib/api/http'
import { authorizationServerMetadata } from '~~/server/lib/api/oauth'

export default defineEventHandler((event) => {
  apiCors(event, 'GET, OPTIONS')
  setHeader(event, 'Cache-Control', 'public, max-age=3600')
  return authorizationServerMetadata(siteBase())
})
