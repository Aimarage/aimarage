import { clientIp } from '~~/server/lib/api/http'
import { appLoginByPassword } from '~~/server/lib/app/core'
import { config } from '~~/server/lib/config'
import { getDb } from '~~/server/lib/db'
import { loginLimiter } from '~~/server/lib/ratelimit'

const body = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(500),
  device: z.string().max(80).optional(),
})

export default defineEventHandler(async (event) => {
  if (!config.authPassword) throw createError({ statusCode: 404, statusMessage: 'Passwort-Anmeldung ist ausgeschaltet' })
  const input = await parseBody(event, body)
  const key = `${clientIp(event)}|${input.email.toLowerCase()}`
  const db = await getDb()
  const wait = await loginLimiter.retryAfter(db, key)
  if (wait) {
    setResponseHeader(event, 'Retry-After', wait)
    throw createError({ statusCode: 429, statusMessage: 'Zu viele Versuche, bitte später erneut' })
  }
  const res = await appLoginByPassword(db, { email: input.email, password: input.password, deviceName: input.device, userAgent: getHeader(event, 'user-agent') ?? '' })
  if (!res) {
    await loginLimiter.fail(db, key)
    throw createError({ statusCode: 401, statusMessage: 'E-Mail oder Passwort falsch' })
  }
  await loginLimiter.reset(db, key)
  return res
})
