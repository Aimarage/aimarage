import { agentReady, withRun, workspaceLlm } from '~~/server/lib/agent'
import { now } from '~~/server/lib/clock'
import { generateQuestions, saveGeo } from '~~/server/lib/geo'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  if (!agentReady(s.workspace)) throw createError({ statusCode: 400, statusMessage: 'Agent nicht konfiguriert' })
  let questions: string[] = []
  await withRun(db, s.workspace, 'geo_check', { projectId: p.id }, async (ctx) => {
    questions = await generateQuestions(workspaceLlm(s.workspace), p, ctx.usage)
    if (!questions.length) return { status: 'skipped', summary: 'Keine Fragen erzeugt' }
    await saveGeo(db, p, { questions, generatedAt: now().toISOString(), editedAt: null })
    return { status: 'ok', summary: `KI-Sichtbarkeit: ${questions.length} Fragen für ${p.name} vorgeschlagen` }
  })
  if (!questions.length) throw createError({ statusCode: 502, statusMessage: 'Keine Fragen erzeugt' })
  return { ok: true, questions }
})
