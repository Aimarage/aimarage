import { agentReady } from '~~/server/lib/agent'
import { syncProjectFeeds } from '~~/server/lib/feeds'
import { timeSuggester } from '~~/server/lib/best-times'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  const r = await syncProjectFeeds(db, s.workspace, p, { draft: agentReady(s.workspace), suggest: timeSuggester(db, s.workspace, p) })
  return { ok: r.feeds.every(f => !f.error), feeds: r.feeds, created: r.created, tasks: r.tasks }
})
