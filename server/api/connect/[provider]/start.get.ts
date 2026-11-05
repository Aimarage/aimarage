import { and, eq } from 'drizzle-orm'
import { config } from '~~/server/lib/config'
import { getDb, schema } from '~~/server/lib/db'
import { startOAuth } from '~~/server/lib/connections'
import { assertAccountLimit, assertSocialAccountLimit } from '~~/server/lib/limits'
import { isOAuthProvider } from '~~/server/lib/platforms/oauth'
import { PlatformError } from '~~/server/lib/platforms/types'

const query = z.object({ project: z.string().uuid().optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const provider = getRouterParam(event, 'provider')!
  if (!isOAuthProvider(provider)) throw createError({ statusCode: 404 })
  const q = parseQuery(event, query)
  const db = await getDb()
  if (q.project) {
    const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, q.project), eq(schema.projects.workspaceId, s.workspace.id)))
    if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  }
  await assertAccountLimit(db, s.workspace, 1)
  await assertSocialAccountLimit(db, s.workspace, 1)
  try {
    return { url: await startOAuth(db, s.workspace, provider, q.project ?? null, config.appUrl) }
  }
  catch (err) {
    if (err instanceof PlatformError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
