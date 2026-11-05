import { clientIp } from '~~/server/lib/api/http'
import { requestLoginCode } from '~~/server/lib/auth-codes'
import { getDb } from '~~/server/lib/db'

const body = z.object({
  email: z.string().trim().min(3).max(254),
  locale: z.enum(['de', 'en']).optional(),
})

// Code per Mail anfordern, gleiche Grenzen wie im Web.
export default defineEventHandler(async (event) => {
  const input = await parseBody(event, body)
  const db = await getDb()
  await authGuard(event, () => requestLoginCode(db, { email: input.email, ip: clientIp(event), locale: input.locale }))
  return { ok: true }
})
