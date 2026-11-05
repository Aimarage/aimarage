import { today } from '~~/server/lib/clock'
import { getDb } from '~~/server/lib/db'
import { endRecurrence, loadRecurrence } from '~~/server/lib/recurrences'

const body = z.object({
  active: z.literal(false),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  await parseBody(event, body)
  const db = await getDb()
  const rec = await loadRecurrence(db, s.workspace.id, await accessOf(db, s), getRouterParam(event, 'id')!)
  if (!rec) throw createError({ statusCode: 404, statusMessage: 'Serie nicht gefunden' })
  const r = await endRecurrence(db, rec, today(s.workspace.timezone), { type: 'user', userId: s.user.id })
  return { ok: true, discarded: r.discarded }
})
