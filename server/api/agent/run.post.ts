import { getDb } from '~~/server/lib/db'
import { enqueueJob } from '~~/server/lib/jobs'
import { assertFullAccess } from '~~/server/lib/preview'

const body = z.object({ job: z.enum(['materialize_recurrences', 'draft_tasks', 'followups', 'daily_briefing', 'weekly_report', 'strategy_review', 'social_stats', 'utm_sync']) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  assertFullAccess(s.workspace)
  const input = await parseBody(event, body)
  await enqueueJob(await getDb(), input.job, { workspaceId: s.workspace.id, dedupeKey: `${input.job}:${s.workspace.id}:manual:${Date.now()}` })
  return { ok: true }
})
