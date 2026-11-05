import { appCtx } from '~~/server/lib/app/core'
import { loadDraft, toApproval } from '~~/server/lib/app/views'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  return appGuard(async () => {
    const c = await appCtx(await getDb(), s)
    const { task, draft, project } = await loadDraft(c, getRouterParam(event, 'id')!)
    return toApproval(c, task, draft, project)
  }, s)
})
