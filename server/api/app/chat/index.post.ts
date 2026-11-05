import { appCtx, projectOf } from '~~/server/lib/app/core'
import { appChatSend } from '~~/server/lib/app/chat'
import { getDb } from '~~/server/lib/db'

const body = z.object({ project: z.string().max(60).nullable().optional(), text: z.string().trim().min(1).max(8000) })

export default defineEventHandler(async (event) => {
  const s = await requireApp(event, 'member')
  const input = await parseBody(event, body)
  return appGuard(async () => {
    const c = await appCtx(await getDb(), s)
    return appChatSend(c, await projectOf(c, input.project), input.text)
  }, s)
})
