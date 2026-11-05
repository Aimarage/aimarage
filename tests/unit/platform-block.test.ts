import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { runToolDirect, type ChatActor } from '../../server/lib/chat'
import { createTask } from '../../server/lib/tasks'
import { workspaceAccessProblems } from '../../server/lib/access-problems'
import { channelBlock, ensureSetupTask, loadPlanGuard } from '../../server/lib/plan-guard'
import { convoEffective } from '../../server/lib/conversation'
import { projectConns } from '../../server/lib/listen-account'
import { socialTarget } from '../../server/lib/publish'
import { runDraftTask } from '../../server/lib/agent'
import { talkAboutTask } from '../../server/lib/talk'
import { materializeRecurrences } from '../../server/lib/materialize'
import { today } from '../../server/lib/clock'
import { addDays } from '../../shared/utils/dates'
import { allowedPlatforms, isPlatformBlocked, taskBlockedPlatform } from '../../shared/utils/blocked-platforms'
import { weekendPolicy } from '../../shared/utils/release'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let owner: string
let actor: ChatActor
let seq = 0
const secret = { enc: 'x', hint: 'x', setAt: '2026-10-01' }
const answer = (content: string) => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })
const llmOnce = (content: string) => (async () => answer(content)) as unknown as typeof fetch

const proj = async (id: string) => (await db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0]!
const task = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
const reloadWs = async () => { ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!; actor = { ...actor, workspace: ws } }

async function mkProject(slug: string, accountIds: string[] = []) {
  const code = slug.slice(0, 3).toUpperCase()
  return (await db.insert(schema.projects).values({ workspaceId: ws.id, slug, name: slug, code, icon: code[0]!, url: `https://${slug}.example`, setup: { social: { accountIds } } }).returning())[0]!
}

beforeAll(async () => {
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Block', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  owner = (await db.insert(schema.users).values({ email: 'owner@block.local', name: 'Peter' }).returning())[0]!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: owner, role: 'owner' })
  actor = { workspace: ws, userId: owner, userName: 'Peter', role: 'owner', access: { all: true, ids: [] } }
})
afterAll(async () => {
  await close()
})

describe('zentrale Sperre', () => {
  it('isPlatformBlocked, allowedPlatforms und taskBlockedPlatform', () => {
    const p = { setup: { blockedPlatforms: ['Mastodon', 'twitter'] } }
    expect(isPlatformBlocked(p, 'mastodon')).toBe(true)
    expect(isPlatformBlocked(p, 'x')).toBe(true)
    expect(isPlatformBlocked(p, 'bluesky')).toBe(false)
    expect(allowedPlatforms(p, ['x', 'bluesky', 'mastodon'])).toEqual(['bluesky'])
    expect(taskBlockedPlatform(p, { title: 'Post zur Tour', category: 'social', channel: 'Mastodon' })).toBe('mastodon')
    expect(taskBlockedPlatform(p, { title: 'Post zur Tour', category: 'social', channel: 'Mastodon, Bluesky' })).toBeNull()
    expect(taskBlockedPlatform(p, { title: 'Konto anlegen', category: 'pflege', origin: 'setup:account:mastodon' })).toBe('mastodon')
  })
})

describe('drop_platform im Chat', () => {
  it('Vorschau ändert nichts, mit confirm: Regel, Konto getrennt, Aufgaben, Fassungen, Posts, Serien, Mitreden', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, connections: [
      { id: 'm1', provider: 'mastodon', platform: 'mastodon', name: 'Mastodon', handle: '@peter@mastodon.social', secret, error: 'HTTP 403: Your login is currently disabled' },
      { id: 'b1', provider: 'bluesky', platform: 'bluesky', name: 'Bluesky', handle: '@peter', secret },
    ] } }).where(eq(schema.workspaces.id, ws.id))
    await reloadWs()
    const p = await mkProject('masto', ['m1', 'b1'])
    await db.update(schema.projects).set({ setup: { ...p.setup, listening: { convo: { mastodon: true, bluesky: true } } } }).where(eq(schema.projects.id, p.id))
    const d = today(ws.timezone)
    const only = await createTask(db, { workspaceId: ws.id, projectId: p.id, title: 'Post: Release', category: 'social', channel: 'Mastodon', dueDate: addDays(d, 2), draftKind: 'post', agentStep: 'x' })
    const multi = await createTask(db, { workspaceId: ws.id, projectId: p.id, title: 'Post: Tour', category: 'social', channel: 'Social', dueDate: addDays(d, 3), draftKind: 'post', agentStep: 'x', status: 'entwurf_fertig' })
    const [draft] = await db.insert(schema.drafts).values({ taskId: multi.id, version: 1, kind: 'post', body: 'Tour!', platforms: ['bluesky', 'mastodon'], variants: { mastodon: 'Tour #music', bluesky: 'Tour' }, byAgent: true }).returning()
    const [post] = await db.insert(schema.socialPosts).values({ workspaceId: ws.id, projectId: p.id, taskId: multi.id, draftId: draft!.id, provider: 'own', profile: 'x', platforms: ['bluesky', 'mastodon'], scheduledAt: new Date(Date.now() + 86_400_000) }).returning()
    const [rec] = await db.insert(schema.recurrences).values({ workspaceId: ws.id, projectId: p.id, rule: 'weekly:TU', title: 'Mastodon-Post', category: 'social', channel: 'Mastodon' }).returning()

    expect((await workspaceAccessProblems(db, ws)).some(a => a.what.includes('Mastodon'))).toBe(true)

    const pre = await runToolDirect(db, actor, 'drop_platform', { project: 'masto', platform: 'Mastodon' }) as { preview: boolean, tasks: string[], drafts: number, posts: number, series: number, removedConnections: string[] }
    expect(pre).toMatchObject({ preview: true, tasks: [only.code], drafts: 1, posts: 1, series: 1, removedConnections: ['Mastodon (@peter@mastodon.social)'] })
    expect((await proj(p.id)).setup.blockedPlatforms).toBeUndefined()
    expect((await task(only.id)).status).toBe('geplant')

    const r = await runToolDirect(db, actor, 'drop_platform', { project: 'masto', platform: 'mastodon', confirm: true }) as { ok: boolean }
    expect(r.ok).toBe(true)
    await reloadWs()
    const after = await proj(p.id)
    expect(after.setup.blockedPlatforms).toEqual(['mastodon'])
    expect(after.rules).toContain('Kein Mastodon')
    expect(after.setup.social?.accountIds).toEqual(['b1'])
    expect(ws.settings.connections!.map(c => c.id)).toEqual(['b1'])
    expect((await task(only.id)).status).toBe('verworfen')
    expect((await task(multi.id)).status).toBe('entwurf_fertig')
    const [dr] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft!.id))
    expect(dr).toMatchObject({ platforms: ['bluesky'], variants: { bluesky: 'Tour' } })
    const [sp] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, post!.id))
    expect(sp!.platforms).toEqual(['bluesky'])
    const [rc] = await db.select().from(schema.recurrences).where(eq(schema.recurrences.id, rec!.id))
    expect(rc!.active).toBe(false)

    // Tagesmail/Konten-Health
    expect((await workspaceAccessProblems(db, ws)).some(a => a.what.includes('Mastodon'))).toBe(false)
    // Mitreden
    expect((await convoEffective(db, ws, after)).mastodon).toBe(false)
    expect((await convoEffective(db, ws, after)).bluesky).toBe(true)
    // Posten
    expect(socialTarget(ws, after)!.platforms.map(x => x.platform)).toEqual(['bluesky'])

    const undo = await runToolDirect(db, actor, 'drop_platform', { project: 'masto', platform: 'mastodon', undo: true }) as { undone: string[] }
    expect(undo.undone).toEqual(['masto'])
    const back = await proj(p.id)
    expect(back.setup.blockedPlatforms).toEqual([])
    expect(back.rules ?? '').not.toContain('Kein Mastodon')
  })

  it('gesperrtes Konto, das noch verbunden ist, meldet keinen Zugangsfehler und wird nicht abgefragt', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, connections: [...(ws.settings.connections ?? []), { id: 'm2', provider: 'mastodon', platform: 'mastodon', name: 'Mastodon 2', secret, error: 'HTTP 403: Your login is currently disabled' }] } }).where(eq(schema.workspaces.id, ws.id))
    await reloadWs()
    const p = await mkProject('kept', ['m2'])
    expect((await workspaceAccessProblems(db, ws)).some(a => a.what.includes('Mastodon 2'))).toBe(true)
    await db.update(schema.projects).set({ setup: { ...p.setup, blockedPlatforms: ['mastodon'] } }).where(eq(schema.projects.id, p.id))
    const blocked = await proj(p.id)
    expect((await workspaceAccessProblems(db, ws)).some(a => a.what.includes('Mastodon 2'))).toBe(false)
    expect(projectConns(ws, blocked, 'mastodon')).toEqual([])
    expect(socialTarget(ws, blocked)).toBeNull()
  })

  it('unbekannte Plattform: klare Fehlermeldung', async () => {
    await expect(runToolDirect(db, actor, 'drop_platform', { project: 'masto', platform: 'myspace' })).rejects.toThrow('Unbekannte Plattform')
  })
})

describe('Planung und Entwurf', () => {
  it('Planer legt für gestrichene Plattform kein Konto an und plant keinen Kanal dafür', async () => {
    const p = await mkProject('linked')
    await db.update(schema.projects).set({ setup: { ...p.setup, blockedPlatforms: ['linkedin'] } }).where(eq(schema.projects.id, p.id))
    const row = await proj(p.id)
    const g = await loadPlanGuard(db, row)
    expect(g.excluded).toContain('linkedin')
    expect(channelBlock(g, { name: 'LinkedIn', places: ['LinkedIn'], category: 'social' })).toBeNull()
    expect(channelBlock(g, { name: 'Business', places: ['LinkedIn', 'X'], category: 'social' })).toEqual({ kind: 'account', platform: 'x' })
    expect(await ensureSetupTask(db, row, { kind: 'account', platform: 'linkedin' }, null, owner, today(ws.timezone))).toBe(false)
  })

  it('vom Menschen verworfene Konto-Aufgabe kommt nicht wieder', async () => {
    const p = await mkProject('again')
    const d = today(ws.timezone)
    expect(await ensureSetupTask(db, p, { kind: 'account', platform: 'threads' }, null, owner, d)).toBe(true)
    const [t] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, p.id), eq(schema.tasks.origin, 'setup:account:threads')))
    await runToolDirect(db, actor, 'update_task', { code: t!.code, status: 'verworfen' })
    expect(await ensureSetupTask(db, p, { kind: 'account', platform: 'threads' }, null, owner, d)).toBe(false)
    expect(await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, p.id), eq(schema.tasks.origin, 'setup:account:threads')))).toHaveLength(1)
  })

  it('Entwurf für gestrichene Plattform wird nicht geschrieben, Serie legt keine Termine an', async () => {
    const p = await mkProject('nodraft')
    await db.update(schema.projects).set({ setup: { ...p.setup, blockedPlatforms: ['mastodon'] } }).where(eq(schema.projects.id, p.id))
    const d = today(ws.timezone)
    const t = await createTask(db, { workspaceId: ws.id, projectId: p.id, title: 'Post: Mastodon-Update', category: 'social', channel: 'Mastodon', dueDate: addDays(d, 1), draftKind: 'post', agentStep: 'x' })
    const r = await runDraftTask(db, ws, t.id)
    expect(r.summary).toContain('Plattform gestrichen')
    expect((await task(t.id)).status).toBe('verworfen')
    const [rec] = await db.insert(schema.recurrences).values({ workspaceId: ws.id, projectId: p.id, rule: 'daily', title: 'Mastodon-Post', category: 'social', channel: 'Mastodon' }).returning()
    await materializeRecurrences(db, ws.id, d, 7)
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.recurrenceId, rec!.id))).toHaveLength(0)
  })
})

describe('Aufgaben-Gespräch setzt die Absage um', () => {
  it('"Ich lege keine LinkedIn-Firmenseite an": Aufgabe verworfen, LinkedIn gestrichen', async () => {
    const p = await mkProject('wsm')
    const d = today(ws.timezone)
    await ensureSetupTask(db, p, { kind: 'account', platform: 'linkedin' }, null, owner, d)
    const [t] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, p.id), eq(schema.tasks.origin, 'setup:account:linkedin')))
    const r = await talkAboutTask(db, ws, t!, owner, 'Ich lege keine LinkedIn-Firmenseite an, dafür braucht man 20 Verbindungen und die will ich nicht.', llmOnce('{"type": "answer", "text": "Alles klar, LinkedIn ist für dieses Projekt gestrichen.", "block": "linkedin"}'))
    expect(r.dropped).toBe(true)
    expect((await task(t!.id)).status).toBe('verworfen')
    const row = await proj(p.id)
    expect(isPlatformBlocked(row, 'linkedin')).toBe(true)
    expect(await ensureSetupTask(db, row, { kind: 'account', platform: 'linkedin' }, null, owner, d)).toBe(false)
  })
})

describe('weitere Werkzeuge', () => {
  it('set_rules: dauerhafte Vorgabe wirkt auf die Terminplanung', async () => {
    const p = await mkProject('rules')
    const r = await runToolDirect(db, actor, 'set_rules', { project: 'rules', add: ['Keine Posts am Wochenende'] }) as { rules: string[] }
    expect(r.rules).toEqual(['Keine Posts am Wochenende'])
    expect(weekendPolicy([(await proj(p.id)).rules]).social).toBe(false)
    await runToolDirect(db, actor, 'set_rules', { project: 'rules', remove: ['wochenende'] })
    expect((await proj(p.id)).rules).toBeNull()
  })

  it('set_profile setzt den Ton', async () => {
    const p = await mkProject('tone')
    await runToolDirect(db, actor, 'set_profile', { project: 'tone', tonality: 'locker, per du, ohne Emojis' })
    expect((await proj(p.id)).tonality).toBe('locker, per du, ohne Emojis')
  })

  it('disconnect_account: erst Vorschau, dann ganz getrennt', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, connections: [...(ws.settings.connections ?? []), { id: 't1', provider: 'telegram', platform: 'telegram', name: 'Telegram', secret }] } }).where(eq(schema.workspaces.id, ws.id))
    await reloadWs()
    const p = await mkProject('tele', ['t1'])
    const pre = await runToolDirect(db, actor, 'disconnect_account', { id: 't1' }) as { preview: boolean, projects: string[] }
    expect(pre).toMatchObject({ preview: true, projects: ['tele'] })
    await runToolDirect(db, actor, 'disconnect_account', { id: 't1', confirm: true })
    await reloadWs()
    expect(ws.settings.connections!.some(c => c.id === 't1')).toBe(false)
    expect((await proj(p.id)).setup.social?.accountIds).toEqual([])
  })
})
