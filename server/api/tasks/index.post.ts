import { CATEGORIES, DRAFT_KINDS, PRIOS } from '~~/shared/utils/domain'
import { isValidIso, isValidTime } from '~~/shared/utils/dates'
import { logActivity } from '~~/server/lib/activity'
import { getDb } from '~~/server/lib/db'
import { createTask } from '~~/server/lib/tasks'
import { releaseFocusFor } from '~~/server/lib/release-focus'
import { today } from '~~/server/lib/clock'
import { oldReleaseHit } from '~~/shared/utils/release-focus'

const body = z.object({
  project: z.string().max(60).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  category: z.enum(CATEGORIES),
  channel: z.string().max(200).nullable().optional(),
  dueDate: z.string().refine(isValidIso).nullable().optional(),
  dueTime: z.string().refine(isValidTime).nullable().optional(),
  durationMin: z.number().int().min(5).max(24 * 60).optional(),
  estimateMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  prio: z.enum(PRIOS).optional(),
  agentStep: z.string().max(300).nullable().optional(),
  humanStep: z.string().max(300).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  draftKind: z.enum(DRAFT_KINDS).nullable().optional(),
  targetUrl: httpUrl(1000).nullable().optional(),
  metric: z.string().max(300).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const project = await resolveProject(db, s, input.project)
  await assertMember(db, s.workspace.id, input.assigneeUserId)
  const { project: _p, ...rest } = input
  const d = today(s.workspace.timezone)
  const focus = project ? await releaseFocusFor(db, project.id, input.dueDate && input.dueDate > d ? input.dueDate : d) : null
  const releaseOk = !!oldReleaseHit(`${input.title}\n${input.description ?? ''}`, focus)
  const t = await createTask(db, { ...rest, workspaceId: s.workspace.id, projectId: project?.id ?? null, createdByUserId: s.user.id, releaseOk })
  await logActivity(db, { workspaceId: s.workspace.id, projectId: t.projectId, taskId: t.id, actor: 'user', userId: s.user.id, action: 'created', detail: { title: t.title } })
  return { id: t.id, code: t.code }
})
