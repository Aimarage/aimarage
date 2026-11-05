import { appCtx } from '~~/server/lib/app/core'
import { appTalk } from '~~/server/lib/app/talk'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  return appGuard(async () => appTalk(await appCtx(await getDb(), s), getRouterParam(event, 'id')!), s)
})
