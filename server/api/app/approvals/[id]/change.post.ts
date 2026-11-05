import { appCtx } from '~~/server/lib/app/core'
import { appChange } from '~~/server/lib/app/actions'
import { getDb } from '~~/server/lib/db'

const body = z.object({ wish: z.string().trim().min(1).max(4000) })

export default defineEventHandler(async (event) => {
  const s = await requireApp(event, 'member')
  const input = await parseBody(event, body)
  return appGuard(async () => appChange(await appCtx(await getDb(), s), getRouterParam(event, 'id')!, input.wish), s)
})
