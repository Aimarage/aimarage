import { experimentsView } from '~~/server/lib/experiments'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event)
  return experimentsView(db, p.id)
})
