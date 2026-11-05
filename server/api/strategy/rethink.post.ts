import { getDb } from '~~/server/lib/db'
import { enqueueJob } from '~~/server/lib/jobs'
import { agentReady } from '~~/server/lib/agent'
import { assertFullAccess } from '~~/server/lib/preview'

const body = z.object({ project: z.string().min(1).max(60), reason: z.string().max(1000).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  assertFullAccess(s.workspace)
  const input = await parseBody(event, body)
  const db = await getDb()
  const project = await resolveProject(db, s, input.project)
  if (!project) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  if (!agentReady(s.workspace)) throw createError({ statusCode: 409, statusMessage: 'Agent nicht konfiguriert' })
  await enqueueJob(db, 'rethink_strategy', { workspaceId: s.workspace.id, payload: { projectId: project.id, userId: s.user.id, reason: input.reason?.trim() || null }, dedupeKey: `rethink:${project.id}:${Date.now()}`, maxAttempts: 1 })
  return { ok: true }
})
