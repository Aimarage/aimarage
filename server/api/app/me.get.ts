import { appCtx } from '~~/server/lib/app/core'
import { appProjects } from '~~/server/lib/app/views'
import { agentReady } from '~~/server/lib/agent'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const s = await requireApp(event)
  const c = await appCtx(await getDb(), s)
  return {
    user: { id: s.user.id, name: s.user.name, email: s.user.email, locale: s.user.locale },
    workspace: { id: s.workspace.id, name: s.workspace.name },
    locale: s.user.locale === 'en' ? 'en' : 'de',
    role: s.role,
    agentReady: agentReady(s.workspace),
    projects: await appProjects(c),
  }
})
