import { appCtx } from '~~/server/lib/app/core'
import { appApprove } from '~~/server/lib/app/actions'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireApp(event, 'member')
  return appGuard(async () => appApprove(await appCtx(await getDb(), s), getRouterParam(event, 'id')!), s)
})
