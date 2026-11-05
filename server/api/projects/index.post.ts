import { PROJECT_COLORS } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { createProjectRecord } from '~~/server/lib/onboarding'

const body = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.enum(PROJECT_COLORS).optional(),
  url: httpUrl(300).nullable().optional().or(z.literal('').transform(() => null)),
  description: z.string().max(2000).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const db = await getDb()
  const p = await createProjectRecord(db, s.workspace, s.user.id, { name: input.name, url: input.url ?? null, description: input.description ?? null, color: input.color ?? null, onboarding: false })
  return { id: p.id, slug: p.slug }
})
