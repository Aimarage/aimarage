import { disconnectGoogle } from '~~/server/lib/search-console'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'admin')
  await disconnectGoogle(db, p)
  return { ok: true }
})
