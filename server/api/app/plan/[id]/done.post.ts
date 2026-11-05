import { appCtx } from '~~/server/lib/app/core'
import { appSetDone } from '~~/server/lib/app/actions'
import { getDb } from '~~/server/lib/db'

const body = z.object({ done: z.boolean() })

export default defineEventHandler(async (event) => {
  const s = await requireApp(event, 'member')
  const input = await parseBody(event, body)
  return appGuard(async () => appSetDone(await appCtx(await getDb(), s), getRouterParam(event, 'id')!, input.done), s)
})
