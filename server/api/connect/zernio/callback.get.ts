import { and, eq } from 'drizzle-orm'
import { ALL_SLUG } from '~~/shared/utils/domain'
import { logActivity } from '~~/server/lib/activity'
import { updateSettings } from '~~/server/lib/connections'
import { getDb, schema } from '~~/server/lib/db'
import { afterHostedConnect } from '~~/server/lib/zernio'

// Rückkehr aus Zernio nach dem Verbinden (Erfolg: connected=..., Fehler: error=...).
export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const q = getQuery(event)
  const db = await getDb()
  const state = typeof q.s === 'string' ? q.s : ''
  const pending = (s.workspace.settings?.oauthStates ?? []).find(x => x.state === state && x.provider.startsWith('zernio:'))
  const projectId = pending?.projectId ?? null
  const [p] = projectId ? await db.select({ slug: schema.projects.slug }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, s.workspace.id))) : []
  const back = (k: string, v: string) => sendRedirect(event, `/p/${p?.slug ?? ALL_SLUG}/konten?${k}=${encodeURIComponent(v.slice(0, 300))}`)
  if (!pending) return back('connectError', 'Anmeldung abgelaufen, bitte erneut verbinden')
  await updateSettings(db, s.workspace.id, x => ({ ...x, oauthStates: (x.oauthStates ?? []).filter(o => o.state !== state) }))
  if (q.error) return back('connectError', String(q.error_message ?? q.error))
  try {
    const platform = pending.provider.slice('zernio:'.length)
    const r = await afterHostedConnect(db, s.workspace.id, { projectId, platform })
    if (r.overLimit && !r.added.length) return back('connectError', 'Höchstzahl an Social-Konten im Tarif erreicht')
    if (r.assigned) await logActivity(db, { workspaceId: s.workspace.id, projectId, actor: 'user', userId: s.user.id, action: 'connection_added', detail: { platform, via: 'zernio' } })
    return back('connected', r.assigned?.name || r.added[0]?.name || platform)
  }
  catch (err) {
    return back('connectError', (err as Error).message)
  }
})
