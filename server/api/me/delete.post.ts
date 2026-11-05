import { DeletionError, deleteAccount } from '~~/server/lib/deletion'
import { SESSION_COOKIE } from '~~/server/lib/auth'
import { getDb } from '~~/server/lib/db'
import { requireStepUp } from '~~/server/utils/auth-http'

const body = z.object({ email: z.string().max(320) })

// Eigenes Konto löschen: Bestätigung mit der eigenen Adresse und Step-up. Danach abgemeldet.
export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  if (input.email.trim().toLowerCase() !== s.user.email.trim().toLowerCase()) throw createError({ statusCode: 400, statusMessage: 'Die Adresse stimmt nicht' })
  requireStepUp(s)
  try {
    const { plan } = await deleteAccount(await getDb(), s.user.id, { userId: s.user.id, via: 'web' })
    deleteCookie(event, SESSION_COOKIE, { path: '/' })
    return { ok: true, left: plan.leave.map(w => w.name), removed: plan.remove.map(w => w.name) }
  }
  catch (err) {
    if (err instanceof DeletionError) throw createError({ statusCode: err.status, statusMessage: err.message, data: err.data })
    throw err
  }
})
