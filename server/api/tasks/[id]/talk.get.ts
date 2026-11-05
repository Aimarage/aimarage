import { getDb } from '~~/server/lib/db'
import { drainTalk, taskTalk } from '~~/server/lib/talk'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  const view = await taskTalk(db, s.workspace, t)
  if (view.canTalk && !view.busy && !view.writing && view.lines.some(l => l.kind === 'queued')) {
    void drainTalk(db, s.workspace, t.id).catch(err => console.error('[talk]', err))
    view.busy = true
  }
  return { task: { id: t.id, code: t.code, title: t.title }, ...view }
})
