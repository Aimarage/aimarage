import { roleAtLeast } from '~~/shared/utils/domain'
import { publicStrong } from '~~/server/lib/llm-strong'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  return publicStrong(s.workspace.settings?.llm, s.workspace.id, roleAtLeast(s.role, 'admin'))
})
