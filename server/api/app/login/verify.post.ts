import { clientIp } from '~~/server/lib/api/http'
import { appLoginByCode } from '~~/server/lib/app/core'
import { getDb } from '~~/server/lib/db'

const body = z.object({
  email: z.string().trim().min(3).max(254),
  code: z.string().trim().min(1).max(20),
  device: z.string().max(80).optional(),
})

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, body)
  const db = await getDb()
  return authGuard(event, () => appLoginByCode(db, { email: input.email, code: input.code, ip: clientIp(event), deviceName: input.device, userAgent: getHeader(event, 'user-agent') ?? '' }))
})
