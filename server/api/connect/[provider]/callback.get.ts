import { and, eq } from 'drizzle-orm'
import { ALL_SLUG } from '~~/shared/utils/domain'
import { config } from '~~/server/lib/config'
import { getDb, schema } from '~~/server/lib/db'
import { finishOAuth } from '~~/server/lib/connections'
import { isOAuthProvider } from '~~/server/lib/platforms/oauth'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const provider = getRouterParam(event, 'provider')!
  if (!isOAuthProvider(provider)) throw createError({ statusCode: 404 })
  const q = getQuery(event)
  const db = await getDb()
  const state = typeof q.state === 'string' && q.state ? q.state : null
  const pending = s.workspace.settings?.oauthStates ?? []
  const projectId = (state ? pending.find(x => x.state === state) : [...pending].reverse().find(x => x.provider === provider))?.projectId ?? null
  const [p] = projectId ? await db.select({ slug: schema.projects.slug }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, s.workspace.id))) : []
  const back = (k: string, v: string) => sendRedirect(event, `/p/${p?.slug ?? ALL_SLUG}/konten?${k}=${encodeURIComponent(v.slice(0, 300))}`)
  if (q.error) return back('connectError', String(q.error_description ?? q.error))
  if (typeof q.code !== 'string') return back('connectError', 'Kein Code erhalten')
  try {
    const list = await finishOAuth(db, s.workspace, provider, q.code, state, config.appUrl)
    return back('connected', list.map(c => c.name).join(', '))
  }
  catch (err) {
    return back('connectError', (err as Error).message)
  }
})
