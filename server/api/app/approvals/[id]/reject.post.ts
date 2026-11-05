import { appCtx } from '~~/server/lib/app/core'
import { appReject } from '~~/server/lib/app/actions'
import { getDb } from '~~/server/lib/db'

const body = z.object({ reason: z.string().max(2000).nullable().optional(), dropTask: z.boolean().nullable().optional() })

export default defineEventHandler(async (event) => {
  const s = await requireApp(event, 'member')
  const input = await parseBody(event, body)
  return appGuard(async () => appReject(await appCtx(await getDb(), s), getRouterParam(event, 'id')!, input.reason ?? null, input.dropTask ?? null), s)
})
