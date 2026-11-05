import { RELEASE_KINDS, validDate } from '~~/shared/utils/release'
import { isValidTime } from '~~/shared/utils/dates'
import { createRelease, planRelease, ReleaseError } from '~~/server/lib/release'

const body = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.enum(RELEASE_KINDS),
  releaseDate: z.string().refine(validDate),
  link: z.string().trim().max(1000).nullable().optional(),
  items: z.string().max(20_000).nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  platforms: z.array(z.string().max(40)).max(20).nullable().optional(),
  start: z.string().refine(validDate).nullable().optional(),
  every: z.number().int().min(1).max(7).nullable().optional(),
  time: z.string().refine(isValidTime).nullable().optional(),
  press: z.boolean().nullable().optional(),
  create: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  const { create, ...input } = await parseBody(event, body)
  try {
    if (!create) return { plan: await planRelease(db, s.workspace, p, input) }
    const r = await createRelease(db, s.workspace, p, input, { userId: s.user.id })
    return { plan: r.plan, created: r.tasks }
  }
  catch (err) {
    if (err instanceof ReleaseError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
