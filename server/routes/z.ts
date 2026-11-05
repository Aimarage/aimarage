import { clientIp } from '../lib/api/http'
import { CounterError, handleHit, MAX_BODY } from '../lib/counter'
import { getDb } from '../lib/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Access-Control-Allow-Origin', '*')
  setHeader(event, 'Access-Control-Allow-Methods', 'POST, OPTIONS')
  setHeader(event, 'Access-Control-Allow-Headers', 'Content-Type')
  setHeader(event, 'Access-Control-Max-Age', 86400)
  setHeader(event, 'Cache-Control', 'no-store')
  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return null
  }
  if (event.method !== 'POST') throw createError({ statusCode: 405 })
  if (Number(getHeader(event, 'content-length') ?? 0) > MAX_BODY) throw createError({ statusCode: 413 })
  try {
    const body = (await readRawBody(event, 'utf8')) ?? ''
    await handleHit(await getDb(), { body, ip: clientIp(event), ua: getHeader(event, 'user-agent'), origin: getHeader(event, 'origin'), referer: getHeader(event, 'referer') })
  }
  catch (err) {
    if (!(err instanceof CounterError)) throw err
    if (err.status !== 204) throw createError({ statusCode: err.status, statusMessage: err.message })
  }
  setResponseStatus(event, 204)
  return null
})
