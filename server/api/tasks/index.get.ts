import { CATEGORIES, DONE_STATUSES, OPEN_STATUSES, STATUSES, type TaskStatus } from '~~/shared/utils/domain'
import { addDays } from '~~/shared/utils/dates'
import { today } from '~~/server/lib/clock'
import { getDb } from '~~/server/lib/db'
import { listTasks, type TaskFilter } from '~~/server/lib/tasks'
import { toItems } from '~~/server/services/views'

const list = <T extends string>(values: readonly T[]) => z.string().optional().transform(v => (v ? v.split(',').filter((x): x is T => (values as readonly string[]).includes(x)) : undefined))

const query = z.object({
  project: z.string().max(60).optional(),
  scope: z.enum(['open', 'today', 'week', 'overdue', 'backlog', 'done', 'all']).default('open'),
  status: list(STATUSES),
  category: list(CATEGORIES),
  assignee: z.union([z.enum(['me', 'agent']), z.string().uuid()]).optional().or(z.literal('').transform(() => undefined)),
  q: z.string().max(100).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  const d = today(s.workspace.timezone)
  const f: TaskFilter = { workspaceId: s.workspace.id, projectId: project?.id ?? null, categories: q.category, search: q.q, assignee: q.assignee === 'me' ? s.user.id : q.assignee || undefined, access: await accessOf(db, s) }
  let statuses: TaskStatus[] | undefined = q.status
  switch (q.scope) {
    case 'open': statuses ??= OPEN_STATUSES; f.backlog = false; break
    case 'today': statuses ??= OPEN_STATUSES; f.from = d; f.to = d; break
    case 'week': statuses ??= OPEN_STATUSES; f.from = d; f.to = addDays(d, 6); break
    case 'overdue': statuses ??= OPEN_STATUSES; f.to = d; break
    case 'backlog': f.backlog = true; statuses ??= OPEN_STATUSES; break
    case 'done': statuses ??= [...DONE_STATUSES, 'verworfen']; break
    case 'all': break
  }
  f.statuses = statuses
  const rows = await listTasks(db, f)
  const all = await toItems(db, s.workspace.id, q.scope === 'done' ? rows.reverse() : rows)
  const items = q.scope === 'overdue' ? all.filter(i => i.overdue) : all
  return { today: d, items }
})
