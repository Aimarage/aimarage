import { publicFeeds, recentFeedItems } from '~~/server/lib/feeds'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event)
  return { feeds: publicFeeds(p.setup?.feeds), recent: await recentFeedItems(db, p.id) }
})
