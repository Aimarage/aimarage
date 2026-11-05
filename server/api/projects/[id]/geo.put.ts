import { now } from '~~/server/lib/clock'
import { cleanQuestions, MAX_QUESTIONS, saveGeo } from '~~/server/lib/geo'

const body = z.object({ questions: z.array(z.string().max(200)).max(10) })

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'admin')
  const input = await parseBody(event, body)
  const questions = cleanQuestions(input.questions)
  if (input.questions.filter(q => q.trim()).length > MAX_QUESTIONS) throw createError({ statusCode: 400, statusMessage: `Höchstens ${MAX_QUESTIONS} Fragen` })
  await saveGeo(db, p, { questions, generatedAt: p.setup?.geo?.generatedAt ?? null, editedAt: now().toISOString() })
  return { ok: true, questions }
})
