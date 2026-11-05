import { appCtx } from '~~/server/lib/app/core'
import { appTalkSend } from '~~/server/lib/app/talk'
import { getDb } from '~~/server/lib/db'

const body = z.object({ text: z.string().trim().min(1).max(4000) })

export default defineEventHandler(async (event) => {
  const s = await requireApp(event, 'member')
  const input = await parseBody(event, body)
  return appGuard(async () => appTalkSend(await appCtx(await getDb(), s), getRouterParam(event, 'id')!, input.text), s)
})
