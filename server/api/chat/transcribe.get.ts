import { sttTarget } from '~~/server/lib/transcribe'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  return { available: !!sttTarget(s.workspace) }
})
