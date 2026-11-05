import { appCtx, projectOf } from '~~/server/lib/app/core'
import { appChat } from '~~/server/lib/app/chat'
import { getDb } from '~~/server/lib/db'

const query = z.object({ project: z.string().max(60).optional() })

// Projekt-Chat: die App fragt alle 1-2 Sekunden nach, solange busy gilt.
export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  const q = parseQuery(event, query)
  return appGuard(async () => {
    const c = await appCtx(await getDb(), s)
    return appChat(c, await projectOf(c, q.project))
  }, s)
})
