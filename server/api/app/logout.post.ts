import { appLogout } from '~~/server/lib/app/core'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  await appLogout(await getDb(), s)
  return { ok: true }
})
