import { roleAtLeast } from '~~/shared/utils/domain'
import { today } from '~~/server/lib/clock'
import { config } from '~~/server/lib/config'
import { publicBing } from '~~/server/lib/bing-webmaster'
import { googleApp, publicGoogle, searchRange, searchSummary } from '~~/server/lib/search-console'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event)
  const google = publicGoogle(p.setup?.google)
  const bing = publicBing(s.workspace, p.setup?.bing)
  const { from, to } = searchRange(today(s.workspace.timezone))
  return {
    admin: roleAtLeast(s.role, 'admin'),
    appReady: !!googleApp(s.workspace, config.appUrl),
    google,
    summary: google?.property ? await searchSummary(db, p.id, from, to, { source: 'google' }) : null,
    bing,
    bingSummary: bing.site && !bing.off ? await searchSummary(db, p.id, from, to, { source: 'bing' }) : null,
  }
})
