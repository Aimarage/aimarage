import { registerPush } from '~~/server/lib/app/core'
import { getDb } from '~~/server/lib/db'

const body = z.object({ token: z.string().trim().min(32).max(200), env: z.enum(['production', 'sandbox']).optional(), locale: z.string().max(10).optional() })

// Geräte-Token für Mitteilungen; gehört zur App-Sitzung und verschwindet mit ihr.
export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  const input = await parseBody(event, body)
  await appGuard(async () => registerPush(await getDb(), s, input), s)
  return { ok: true }
})
