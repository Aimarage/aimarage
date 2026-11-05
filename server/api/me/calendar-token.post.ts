import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { config } from '~~/server/lib/config'
import { getDb, schema } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const token = randomBytes(24).toString('base64url')
  await (await getDb()).update(schema.users).set({ calendarToken: token }).where(eq(schema.users.id, s.user.id))
  return { url: `${config.appUrl}/ical/${token}.ics` }
})
