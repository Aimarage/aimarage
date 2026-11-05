import { unregisterPush } from '~~/server/lib/app/core'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  return { ok: await unregisterPush(await getDb(), s) }
})
