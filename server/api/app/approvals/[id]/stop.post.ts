import { appCtx } from '~~/server/lib/app/core'
import { appStop } from '~~/server/lib/app/actions'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireApp(event, 'member')
  return appGuard(async () => appStop(await appCtx(await getDb(), s), getRouterParam(event, 'id')!), s)
})
