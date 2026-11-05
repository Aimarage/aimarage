import { agentReady, workspaceLlm } from '~~/server/lib/agent'
import { latestAudit, seoGroupTasks, seoTasks } from '~~/server/lib/seo-audit'

const body = z.object({ group: z.string().trim().min(1).max(40) })

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  const input = await parseBody(event, body)
  const audit = await latestAudit(db, p.id)
  if (!audit || audit.error) throw createError({ statusCode: 400, statusMessage: 'Keine SEO-Prüfung vorhanden' })
  const llm = agentReady(s.workspace) ? workspaceLlm(s.workspace) : null
  await seoTasks(db, s.workspace, p, audit, { llm, only: input.group })
  const task = (await seoGroupTasks(db, p.id, audit.checkedAt))[input.group]
  if (!task) throw createError({ statusCode: 404, statusMessage: 'Kein Fund in dieser Gruppe' })
  return { ok: true, task }
})
