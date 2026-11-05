import { and, eq } from 'drizzle-orm'
import { logActivity } from '~~/server/lib/activity'
import { getDb, schema } from '~~/server/lib/db'
import { listConnections, removeConnection } from '~~/server/lib/connections'
import { hostedAccounts } from '~~/server/lib/social'
import { disconnectAccount, hostedConfig, syncHostedAccounts } from '~~/server/lib/zernio'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  const acc = decodeURIComponent(getRouterParam(event, 'acc') ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(id) || !acc) throw createError({ statusCode: 404 })
  const db = await getDb()
  const all = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, s.workspace.id))
  const p = all.find(x => x.id === id)
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  const social = p.setup?.social ?? {}
  const ups = s.workspace.settings?.social?.accounts ?? []
  const up = ups.find(a => a.id === acc)
  let accountIds = (social.accountIds ?? []).filter(x => x !== acc)
  let profileIds = social.profileIds ?? []
  if (up?.profileId && profileIds.includes(up.profileId)) {
    profileIds = profileIds.filter(x => x !== up.profileId)
    accountIds = [...new Set([...accountIds, ...ups.filter(a => a.profileId === up.profileId && a.id !== acc).map(a => a.id)])]
  }
  await db.update(schema.projects).set({ setup: { ...p.setup, social: { ...social, accountIds, profileIds } } }).where(and(eq(schema.projects.id, p.id), eq(schema.projects.workspaceId, s.workspace.id)))
  const own = listConnections(s.workspace).some(c => c.id === acc)
  const elsewhere = all.some(x => x.id !== p.id && (x.setup?.social?.accountIds ?? []).includes(acc))
  if (own && !elsewhere) await removeConnection(db, s.workspace.id, acc)
  const cfg = hostedConfig(s.workspace)
  const hosted = !!cfg && hostedAccounts(s.workspace.settings?.social).some(a => a.id === acc)
  if (hosted && !elsewhere) {
    await disconnectAccount(cfg!, acc)
    await syncHostedAccounts(db, s.workspace.id, cfg!).catch(() => null)
  }
  await logActivity(db, { workspaceId: s.workspace.id, projectId: p.id, actor: 'user', userId: s.user.id, action: 'connection_removed', detail: {} })
  return { ok: true, removed: (own || hosted) && !elsewhere }
})
