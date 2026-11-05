import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { ownLlmUsage, publicOwnLlm } from '~~/server/lib/own-llm'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const out = publicOwnLlm(s.workspace, roleAtLeast(s.role, 'admin'))
  return { ...out, usage: out.key.set ? await ownLlmUsage(await getDb(), s.workspace) : null }
})
