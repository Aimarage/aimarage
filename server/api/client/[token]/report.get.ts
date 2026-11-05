import { getDb } from '~~/server/lib/db'
import { clientReportPage } from '~~/server/services/client'
import { reportHeaders } from '~~/server/services/report'

export default defineEventHandler(async (event) => {
  await clientGate(event)
  const r = await clientReportPage(await getDb(), getRouterParam(event, 'token') ?? '')
  if (r.status !== 200 || !r.html) throw createError({ statusCode: 404 })
  setResponseHeaders(event, reportHeaders())
  return r.html
})
