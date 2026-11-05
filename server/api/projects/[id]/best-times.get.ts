import { bestTimes, MIN_POSTS } from '~~/server/lib/best-times'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event)
  return { platforms: await bestTimes(db, s.workspace, p), min: MIN_POSTS }
})
