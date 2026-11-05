import type { Category, DraftKind, Prio } from '~~/shared/utils/domain'

export interface TaskFormValue {
  project: string | null
  title: string
  description: string
  category: Category
  channel: string
  dueDate: string
  dueTime: string
  durationMin: number
  estimateMin: number | null
  prio: Prio
  agentStep: string
  humanStep: string
  assigneeUserId: string | null
  draftKind: DraftKind | null
  targetUrl: string
  metric: string
  followUpOn: string
}


export function emptyTaskForm(project: string | null, userId: string | null, dueDate: string): TaskFormValue {
  return { project, title: '', description: '', category: 'content', channel: '', dueDate, dueTime: '', durationMin: 30, estimateMin: 15, prio: 'P2', agentStep: '', humanStep: '', assigneeUserId: userId, draftKind: null, targetUrl: '', metric: '', followUpOn: '' }
}

export function formToBody(v: TaskFormValue) {
  const n = (s: string) => (s.trim() ? s.trim() : null)
  return {
    project: v.project,
    title: v.title.trim(),
    description: n(v.description),
    category: v.category,
    channel: n(v.channel),
    dueDate: v.dueDate || null,
    dueTime: v.dueDate && v.dueTime ? v.dueTime.slice(0, 5) : null,
    durationMin: Number(v.durationMin) || 30,
    estimateMin: v.estimateMin === null || (v.estimateMin as unknown) === '' ? null : Number(v.estimateMin),
    prio: v.prio,
    agentStep: n(v.agentStep),
    humanStep: n(v.humanStep),
    assigneeUserId: v.assigneeUserId,
    draftKind: v.draftKind,
    targetUrl: n(v.targetUrl),
    metric: n(v.metric),
    followUpOn: v.followUpOn || null,
  }
}
