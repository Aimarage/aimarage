import { enqueueJob } from '~~/server/lib/jobs'
import { addFeed, FeedError, publicFeeds } from '~~/server/lib/feeds'

const body = z.object({ url: z.string().trim().min(4).max(500) })

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  const input = await parseBody(event, body)
  try {
    const r = await addFeed(db, p, input)
    await enqueueJob(db, 'feed_sync', { workspaceId: s.workspace.id, payload: { projectId: p.id }, dedupeKey: `feed_sync:${p.id}:${Date.now()}`, maxAttempts: 1 })
    return { ok: true, feed: publicFeeds([r.feed])[0], entries: r.entries }
  }
  catch (err) {
    if (err instanceof FeedError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
