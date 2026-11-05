import { eq } from 'drizzle-orm'
import { ALL_SLUG } from '~~/shared/utils/domain'
import { config } from '~~/server/lib/config'
import { getDb, schema } from '~~/server/lib/db'
import { finishOAuth } from '~~/server/lib/connections'
import { enqueueJob } from '~~/server/lib/jobs'
import { finishGoogle } from '~~/server/lib/search-console'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const q = getQuery(event)
  const db = await getDb()
  const state = typeof q.state === 'string' ? q.state : null
  const yt = (s.workspace.settings?.oauthStates ?? []).find(x => x.state === state && x.provider === 'youtube')
  if (yt) {
    const [pr] = yt.projectId ? await db.select({ slug: schema.projects.slug, workspaceId: schema.projects.workspaceId }).from(schema.projects).where(eq(schema.projects.id, yt.projectId)) : []
    const to = (k: string, v: string) => sendRedirect(event, `/p/${pr && pr.workspaceId === s.workspace.id ? pr.slug : ALL_SLUG}/konten?${k}=${encodeURIComponent(v.slice(0, 300))}`)
    if (q.error) return to('connectError', String(q.error_description ?? q.error))
    if (typeof q.code !== 'string') return to('connectError', 'Kein Code erhalten')
    try {
      return to('connected', (await finishOAuth(db, s.workspace, 'youtube', q.code, state, config.appUrl)).map(c => c.name).join(', '))
    }
    catch (err) {
      return to('connectError', (err as Error).message)
    }
  }
  const pending = (s.workspace.settings?.oauthStates ?? []).find(x => x.state === state && x.provider === 'google')
  const [p] = pending?.projectId ? await db.select({ slug: schema.projects.slug, workspaceId: schema.projects.workspaceId }).from(schema.projects).where(eq(schema.projects.id, pending.projectId)) : []
  const slug = p && p.workspaceId === s.workspace.id ? p.slug : ALL_SLUG
  const back = (k: string, v: string) => sendRedirect(event, `/p/${slug}/berichte?${k}=${encodeURIComponent(v.slice(0, 300))}`)
  if (q.error) return back('googleError', String(q.error_description ?? q.error))
  if (typeof q.code !== 'string') return back('googleError', 'Kein Code erhalten')
  try {
    const r = await finishGoogle(db, s.workspace, q.code, state, config.appUrl)
    if (r.property) await enqueueJob(db, 'search_sync', { workspaceId: s.workspace.id, payload: { projectId: r.projectId }, dedupeKey: `search_sync:${r.projectId}:connect:${Date.now()}`, maxAttempts: 1 })
    return back('google', r.property ?? '')
  }
  catch (err) {
    return back('googleError', (err as Error).message)
  }
})
