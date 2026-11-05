import { getDb } from '~~/server/lib/db'
import { accountDeletionPlan } from '~~/server/lib/deletion'

// Vorschau zum Löschen des eigenen Kontos: welche Arbeitsbereiche verlassen, mitgelöscht oder blockiert werden.
export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  return accountDeletionPlan(await getDb(), s.user.id)
})
