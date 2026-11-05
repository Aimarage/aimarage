import { getDb } from '~~/server/lib/db'
import { isLimitError } from '~~/server/lib/limits'
import { importProject, projectImportSchema } from '~~/server/lib/project-import'

const body = projectImportSchema.extend({ slug: z.string().regex(/^[a-z0-9-]{2,40}$/).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const { slug, ...input } = await parseBody(event, body)
  try {
    return await importProject(await getDb(), s.workspace, s.user.id, input, slug)
  }
  catch (err) {
    if (isLimitError(err)) throw err
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
})
