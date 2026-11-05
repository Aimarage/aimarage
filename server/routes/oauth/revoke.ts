import { getDb } from '~~/server/lib/db'
import { apiCors } from '~~/server/lib/api/http'
import { revokeToken } from '~~/server/lib/api/oauth'
import { oauthError, readOAuthBody } from '~~/server/utils/oauth'

export default defineEventHandler(async (event) => {
  apiCors(event, 'POST, OPTIONS')
  setHeader(event, 'Cache-Control', 'no-store')
  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }
  if (event.method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  try {
    const p = await readOAuthBody(event)
    if (p.token) await revokeToken(await getDb(), p.token)
    return {}
  }
  catch (err) {
    return oauthError(event, err)
  }
})
