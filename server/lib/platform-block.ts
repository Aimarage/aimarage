import { and, eq, inArray, isNull } from 'drizzle-orm'
import { OPEN_STATUSES } from '../../shared/utils/domain'
import { blockedPlatforms, blockRuleLine, taskBlockedPlatform } from '../../shared/utils/blocked-platforms'
import { CONVO_PLATFORMS, type ConvoPlatform } from '../../shared/utils/listening'
import { platformRule } from '../../shared/utils/social'
import { logActivity } from './activity'
import { withChannelPlaces } from './channel-places'
import { now, today } from './clock'
import { listConnections, removeConnection } from './connections'
import type { Db } from './db'
import { schema } from './db'
import { hostedAccounts } from './social'
import { activeStrategy, projectOwner, syncRecurrences } from './strategy'
import { updateTask } from './tasks'
import { fromZernio } from './zernio'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export interface PlatformDropResult {
  platform: string
  label: string
  projects: string[]
  tasks: string[]
  drafts: number
  posts: number
  series: number
  accounts: string[]
  removedConnections: string[]
}

// Konto-Ids (eigene Verbindungen, Zernio/Upload-Post-Konten) einer Plattform im Arbeitsbereich.
function accountIdsOf(ws: Workspace, platform: string): { id: string, name: string, own: boolean }[] {
  const s = ws.settings?.social
  const own = listConnections(ws).filter(c => c.platform === platform).map(c => ({ id: c.id, name: c.handle ? `${c.name} (${c.handle})` : c.name, own: true }))
  const pool = [...(s?.accounts ?? []), ...hostedAccounts(s)]
  const ext = pool.filter(a => fromZernio(a.platform) === platform).map(a => ({ id: a.id, name: a.name, own: false }))
  return [...own, ...ext]
}

function withRule(rules: string | null, line: string): string {
  const cur = (rules ?? '').trim()
  return cur.split('\n').some(l => l.trim() === line) ? cur : [cur, line].filter(Boolean).join('\n')
}

function withoutRule(rules: string | null, line: string): string | null {
  const left = (rules ?? '').split('\n').filter(l => l.trim() !== line).join('\n').trim()
  return left || null
}

// Plattform für Projekte streichen: Regel setzen, Konten aus der Zuordnung, offene Aufgaben nur für diese Plattform verwerfen,
// Plattform aus Fassungen und geplanten Posts, Mitreden aus, Serien aus. apply=false liefert nur die Vorschau.
export async function dropPlatform(db: Db, ws: Workspace, projects: Project[], platform: string, opts: { userId: string | null, apply: boolean, disconnect?: boolean }): Promise<PlatformDropResult> {
  const label = platformRule(platform).label
  const accounts = accountIdsOf(ws, platform)
  const accIds = new Set(accounts.map(a => a.id))
  const out: PlatformDropResult = { platform, label, projects: projects.map(p => p.name), tasks: [], drafts: 0, posts: 0, series: 0, accounts: [], removedConnections: [] }
  const line = blockRuleLine(label)
  for (const p0 of projects) {
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, p0.id))
    if (!p) continue
    const social = p.setup?.social ?? {}
    const assigned = (social.accountIds ?? []).filter(id => accIds.has(id))
    out.accounts.push(...accounts.filter(a => assigned.includes(a.id)).map(a => a.name))
    const listening = p.setup?.listening ?? {}
    const convo = (CONVO_PLATFORMS as readonly string[]).includes(platform) ? { ...listening.convo, [platform as ConvoPlatform]: false } : listening.convo
    const setup = {
      ...p.setup,
      blockedPlatforms: [...new Set([...blockedPlatforms(p), platform])],
      social: { ...social, accountIds: (social.accountIds ?? []).filter(id => !accIds.has(id)) },
      ...(convo !== listening.convo ? { listening: { ...listening, convo } } : {}),
    }
    const after = { ...p, setup }
    const open = await withChannelPlaces(db, await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, p.id), inArray(schema.tasks.status, [...OPEN_STATUSES]))))
    const drop = open.filter(t => taskBlockedPlatform(after, t))
    out.tasks.push(...drop.map(t => t.code))
    const keep = open.filter(t => !drop.includes(t)).map(t => t.id)
    const drafts = keep.length ? (await db.select().from(schema.drafts).where(and(inArray(schema.drafts.taskId, keep), inArray(schema.drafts.status, ['offen', 'freigegeben'])))).filter(d => d.platforms.includes(platform) || platform in (d.variants ?? {})) : []
    out.drafts += drafts.length
    const posts = (await db.select().from(schema.socialPosts).where(and(eq(schema.socialPosts.projectId, p.id), eq(schema.socialPosts.status, 'geplant')))).filter(s => s.platforms.includes(platform))
    out.posts += posts.length
    const recs = (await db.select().from(schema.recurrences).where(and(eq(schema.recurrences.projectId, p.id), eq(schema.recurrences.active, true)))).filter(r => taskBlockedPlatform(after, { title: r.title, category: r.category, channel: r.channel, description: r.description }))
    out.series += recs.length
    if (!opts.apply) continue
    await db.update(schema.projects).set({ setup, rules: withRule(p.rules, line) }).where(eq(schema.projects.id, p.id))
    for (const t of drop) {
      await db.update(schema.drafts).set({ status: 'verworfen' }).where(and(eq(schema.drafts.taskId, t.id), inArray(schema.drafts.status, ['offen', 'freigegeben'])))
      await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: true, text: `Verworfen: ${label} ist für ${p.name} gestrichen.`, createdAt: now() })
      await updateTask(db, t, { status: 'verworfen' }, { type: 'user', userId: opts.userId })
    }
    for (const d of drafts) {
      const { [platform]: _gone, ...variants } = d.variants ?? {}
      await db.update(schema.drafts).set({ platforms: d.platforms.filter(x => x !== platform), variants }).where(eq(schema.drafts.id, d.id))
    }
    for (const s of posts) {
      const left = s.platforms.filter(x => x !== platform)
      await db.update(schema.socialPosts).set(left.length ? { platforms: left, updatedAt: now() } : { status: 'abgebrochen', error: `${label} gestrichen`, updatedAt: now() }).where(eq(schema.socialPosts.id, s.id))
    }
    if (recs.length) await db.update(schema.recurrences).set({ active: false }).where(inArray(schema.recurrences.id, recs.map(r => r.id)))
    const strat = await activeStrategy(db, p.id)
    if (strat) await syncRecurrences(db, after, strat.channels, today(ws.timezone), await projectOwner(db, p.id))
    await logActivity(db, { workspaceId: ws.id, projectId: p.id, actor: 'user', userId: opts.userId, action: 'platform_blocked', detail: { title: p.name, platform, tasks: drop.length }, at: now() })
  }
  // Konten, die nach dem Streichen in keinem aktiven Projekt mehr gebraucht werden, ganz trennen.
  const rest = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))
  const doomed = opts.disconnect !== false && rest.length > 0 && rest.every(p => projects.some(x => x.id === p.id) || blockedPlatforms(p).includes(platform))
  for (const a of accounts.filter(x => x.own)) {
    const used = rest.some(p => !projects.some(x => x.id === p.id) && p.setup?.social?.accountIds?.includes(a.id))
    if (!doomed || used) continue
    out.removedConnections.push(a.name)
    if (opts.apply) await removeConnection(db, ws.id, a.id)
  }
  out.accounts = [...new Set(out.accounts)]
  return out
}

// Streichung zurücknehmen: Regel und Sperre weg. Konten müssen neu verbunden werden.
export async function unblockPlatform(db: Db, ws: Workspace, projects: Project[], platform: string, userId: string | null): Promise<string[]> {
  const line = blockRuleLine(platformRule(platform).label)
  const changed: string[] = []
  for (const p of projects) {
    if (!blockedPlatforms(p).includes(platform)) continue
    const convo = { ...p.setup?.listening?.convo }
    delete convo[platform as ConvoPlatform]
    const setup = { ...p.setup, blockedPlatforms: blockedPlatforms(p).filter(x => x !== platform), ...(p.setup?.listening ? { listening: { ...p.setup.listening, convo } } : {}) }
    await db.update(schema.projects).set({ setup, rules: withoutRule(p.rules, line) }).where(eq(schema.projects.id, p.id))
    await logActivity(db, { workspaceId: ws.id, projectId: p.id, actor: 'user', userId, action: 'platform_unblocked', detail: { title: p.name, platform }, at: now() })
    changed.push(p.name)
  }
  return changed
}

// Verbundenes Konto ganz trennen: Zugangsdaten weg, aus allen Projekten.
export async function disconnectAccount(db: Db, ws: Workspace, id: string, userId: string | null): Promise<{ name: string, projects: string[] } | null> {
  const conn = listConnections(ws).find(c => c.id === id)
  if (!conn) return null
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))
  const names: string[] = []
  for (const p of rows) {
    const ids = p.setup?.social?.accountIds ?? []
    if (!ids.includes(id)) continue
    names.push(p.name)
    await db.update(schema.projects).set({ setup: { ...p.setup, social: { ...p.setup.social, accountIds: ids.filter(x => x !== id) } } }).where(eq(schema.projects.id, p.id))
  }
  await removeConnection(db, ws.id, id)
  await logActivity(db, { workspaceId: ws.id, actor: 'user', userId, action: 'connection_removed', detail: { title: conn.name, platform: conn.platform }, at: now() })
  return { name: conn.handle ? `${conn.name} (${conn.handle})` : conn.name, projects: names }
}
