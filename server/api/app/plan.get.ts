import { isValidIso } from '~~/shared/utils/dates'
import { appCtx, projectOf } from '~~/server/lib/app/core'
import { appPlan } from '~~/server/lib/app/views'
import { getDb } from '~~/server/lib/db'

const query = z.object({ project: z.string().max(60).optional(), week: z.string().refine(isValidIso).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  const q = parseQuery(event, query)
  return appGuard(async () => {
    const c = await appCtx(await getDb(), s)
    return appPlan(c, await projectOf(c, q.project), q.week)
  }, s)
})
