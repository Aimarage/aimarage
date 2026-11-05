import { getDb } from '~~/server/lib/db'
import { bootData } from '~~/server/services/boot'

export default defineEventHandler(async (event) => {
  const s = await loadSession(event)
  if (!s) return { user: null }
  return bootData(await getDb(), s)
})
