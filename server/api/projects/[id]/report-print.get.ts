import { workspaceBrand } from '~~/server/lib/extensions'
import { assertFullAccess } from '~~/server/lib/preview'
import { buildWeeklyReport, renderReportHtml, reportHeaders } from '~~/server/services/report'

const query = z.object({ lang: z.enum(['de', 'en']).optional(), days: z.coerce.number().int().min(7).max(31).optional() })

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event)
  assertFullAccess(s.workspace)
  const q = parseQuery(event, query)
  const lang = q.lang ?? (s.user.locale === 'en' ? 'en' : 'de')
  setResponseHeaders(event, reportHeaders())
  const brand = await workspaceBrand(db, s.workspace.id)
  return renderReportHtml(await buildWeeklyReport(db, s.workspace, p, { days: q.days }), lang, brand ? { brand: brand.name } : {})
})
