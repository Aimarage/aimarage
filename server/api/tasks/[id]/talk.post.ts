import { agentReady } from '~~/server/lib/agent'
import { getDb } from '~~/server/lib/db'
import { LlmError } from '~~/server/lib/llm'
import { talkOrQueue } from '~~/server/lib/talk'

const body = z.object({ text: z.string().trim().min(1).max(4000) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  if (!agentReady(s.workspace)) throw createError({ statusCode: 409, statusMessage: 'Agent nicht konfiguriert' })
  try {
    return await talkOrQueue(db, s.workspace, t, s.user.id, input.text)
  }
  catch (err) {
    const timeout = err instanceof LlmError && err.code === 'network'
    throw createError({ statusCode: timeout ? 504 : 502, statusMessage: timeout ? 'Der Agent antwortet gerade nicht. Bitte gleich nochmal senden.' : `Agent-Antwort fehlgeschlagen: ${(err as Error).message.slice(0, 200)}` })
  }
})
