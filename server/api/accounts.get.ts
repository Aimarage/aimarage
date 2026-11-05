import { and, eq, isNull } from 'drizzle-orm'
import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb, schema } from '~~/server/lib/db'
import { projectCond } from '~~/server/lib/access'
import { publicConnections } from '~~/server/lib/connections'
import { publicMail } from '~~/server/lib/mail'
import { appOf, OAUTH_PROVIDERS } from '~~/server/lib/platforms/oauth'
import { hostedAccounts, projectAccounts, socialConfig, socialEnvAllowed } from '~~/server/lib/social'
import { socialAccountUsage } from '~~/server/lib/limits'
import { ZERNIO_PLATFORMS } from '~~/server/lib/zernio'
import { AUTO_READY } from '~~/server/lib/listening'
import { listenModeOf } from '~~/shared/utils/listening'
import { convoEffective } from '~~/server/lib/conversation'

const query = z.object({ project: z.string().trim().max(100).optional() })

const plat = (p: string) => (p.toLowerCase() === 'twitter' ? 'x' : p.toLowerCase())

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const ws = s.workspace
  const admin = roleAtLeast(s.role, 'admin')
  const one = q.project ? await resolveProject(db, s, q.project) : null
  const rows = one ? [one] : await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt), projectCond(await accessOf(db, s), schema.projects.id, false))).orderBy(schema.projects.sortOrder, schema.projects.name)
  const conns = publicConnections(ws)
  const scfg = socialConfig(ws.settings?.social, ws.id, undefined, socialEnvAllowed(ws.settings))
  const hosted = scfg.keySource === 'hosted'
  const ups = hosted ? hostedAccounts(ws.settings?.social) : ws.settings?.social?.accounts ?? []
  const via = scfg.provider === 'zernio' ? 'zernio' as const : 'uploadpost' as const
  const projects = await Promise.all(rows.map(async (p) => {
    const ids = new Set(p.setup?.social?.accountIds ?? [])
    const own = conns.filter(c => ids.has(c.id)).map(c => ({ id: c.id, platform: c.platform, name: admin ? c.name : null, handle: admin ? c.handle : null, error: c.error ?? (c.readable ? null : 'unreadable'), expiresAt: c.expiresAt, via: 'own' as const, options: c.options }))
    const up = projectAccounts(p.setup?.social, ups).map(a => ({ id: a.id, platform: plat(a.platform), name: admin ? a.name : null, handle: null, error: null, expiresAt: null, via, options: null }))
    const mail = p.setup?.mail
    return { id: p.id, slug: p.slug, name: p.name, color: p.color, icon: p.icon, accounts: [...own, ...up], mail: admin ? publicMail(mail) : null, mailFrom: mail ? mail.from : null, mailError: mail?.error ?? null, listening: { mode: listenModeOf(p.setup), pausedUntil: p.setup?.listening?.pausedUntil ?? null, auto: AUTO_READY, convo: await convoEffective(db, s.workspace, p), voices: (p.setup?.listening?.voices?.list ?? []).map(v => ({ platform: v.platform, handle: v.handle, name: v.name ?? null, followers: v.followers ?? null, pinned: !!v.pinned, blocked: !!v.blocked, source: v.source })), voicesAt: p.setup?.listening?.voices?.at ?? null } }
  }))
  let unassigned: { id: string, platform: string, name: string }[] = []
  if (admin && !one) {
    const all = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))
    const used = new Set(all.flatMap(p => p.setup?.social?.accountIds ?? []))
    unassigned = conns.filter(c => !used.has(c.id)).map(c => ({ id: c.id, platform: c.platform, name: c.name }))
  }
  return {
    admin,
    live: !!ws.settings?.publishLive,
    sendLive: !!ws.settings?.sendLive,
    apps: Object.fromEntries(OAUTH_PROVIDERS.map(p => [p, !!(ws.settings?.apps?.[appOf(p)]?.clientId && ws.settings.apps[appOf(p)]?.secret)])) as Record<string, boolean>,
    projects,
    hosted: { zernio: hosted && admin, platforms: hosted ? [...ZERNIO_PLATFORMS] : [], ...socialAccountUsage(ws) },
    spare: admin ? [...conns.map(c => ({ id: c.id, platform: c.platform, name: c.name })), ...ups.map(a => ({ id: a.id, platform: plat(a.platform), name: a.name }))] : [],
    unassigned,
  }
})
