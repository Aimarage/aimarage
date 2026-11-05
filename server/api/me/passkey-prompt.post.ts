import { eq } from 'drizzle-orm'
import { now } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { PASSKEY_SNOOZE_DAYS } from '~~/server/lib/webauthn'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const until = new Date(now().getTime() + PASSKEY_SNOOZE_DAYS * 86_400_000).toISOString()
  await (await getDb()).update(schema.users).set({ prefs: { ...s.user.prefs, passkeySnoozedUntil: until } }).where(eq(schema.users.id, s.user.id))
  return { ok: true, snoozedUntil: until }
})
