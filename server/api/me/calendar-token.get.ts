import { config } from '~~/server/lib/config'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  return { url: s.user.calendarToken ? `${config.appUrl}/ical/${s.user.calendarToken}.ics` : null }
})
