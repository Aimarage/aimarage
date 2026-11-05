import { appCtx, projectOf } from '~~/server/lib/app/core'
import { appResults } from '~~/server/lib/app/views'
import { getDb } from '~~/server/lib/db'

const query = z.object({ project: z.string().max(60).optional(), period: z.enum(['week', 'month']).default('week') })

export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  const q = parseQuery(event, query)
  return appGuard(async () => {
    const c = await appCtx(await getDb(), s)
    return appResults(c, await projectOf(c, q.project), q.period)
  }, s)
})
