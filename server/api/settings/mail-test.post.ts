import { getDb } from '~~/server/lib/db'
import { RateLimiter } from '~~/server/lib/ratelimit'
import { sendSystemMail, systemMailConfig } from '~~/server/lib/system-mail'

const limiter = new RateLimiter('mail-test', 6, 60 * 60_000)

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'owner')
  const db = await getDb()
  const wait = await limiter.hit(db, s.user.id)
  if (wait) {
    setResponseHeader(event, 'Retry-After', wait)
    throw createError({ statusCode: 429, statusMessage: 'Zu viele Testmails, bitte später erneut' })
  }
  const en = s.user.locale === 'en'
  try {
    const delivery = await sendSystemMail(s.user.email, 'generic-notice', {
      subject: en ? 'Aimarage test email' : 'Testmail von Aimarage',
      name: s.user.name,
      body: en
        ? `This is a test email from the workspace "${s.workspace.name}".\n\nIf you can read it, system emails (sign-in codes, notices) are working.`
        : `Das ist eine Testmail aus dem Arbeitsbereich "${s.workspace.name}".\n\nWenn du sie lesen kannst, kommen Systemmails (Anmeldecodes, Hinweise) an.`,
    }, s.user.locale)
    return { ok: true, delivery, to: s.user.email, from: systemMailConfig.from }
  }
  catch (err) {
    return { ok: false, to: s.user.email, error: (err as Error).message.slice(0, 300) }
  }
})
