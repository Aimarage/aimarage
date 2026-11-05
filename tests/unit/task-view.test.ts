import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { draftLists } from '../../server/lib/approval-lists'
import { openTaskViews } from '../../server/lib/task-view'
import { updateTask } from '../../server/lib/tasks'
import { morningDigests } from '../../server/lib/morning-digest'
import { aiDone, dashboardView } from '../../server/services/views'
import { plural } from '../../shared/utils/plural'
import { liveMatcher } from '../../shared/utils/channel-live'
import { todoOf } from '../../shared/utils/todo'
import { accountPlace } from '../../server/lib/todo'
import { countsAsDone } from '../../shared/utils/task-state'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let peter: string
let bmx: string
let vis: string
let n = 0
const d = '2026-10-13'
const prevNow = process.env.MA_NOW

async function task(o: Partial<typeof schema.tasks.$inferInsert>) {
  n++
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: bmx, code: `T-${String(n).padStart(3, '0')}`, title: `Aufgabe ${n}`, category: 'community', humanStep: 'Prüfen und selbst posten', dueDate: d, ...o }).returning()
  return t!
}

async function draft(taskId: string, o: Partial<typeof schema.drafts.$inferInsert> = {}) {
  const [x] = await db.insert(schema.drafts).values({ taskId, kind: 'post', body: 'x', byAgent: true, ...o }).returning()
  return x!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:00:00Z'
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', timezone: 'Europe/Vienna' }).returning())[0]!
  peter = (await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning())[0]!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: peter, role: 'owner' })
  bmx = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'linkbox', name: 'linkbox', code: 'BMX', icon: 'B' }).returning())[0]!.id
  vis = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'The Wanderer', code: 'THE', icon: 'T' }).returning())[0]!.id
})
afterAll(async () => {
  process.env.MA_NOW = prevNow
  if (prevNow === undefined) delete process.env.MA_NOW
  await close()
})

describe('Dashboard, Freigaben, Menü und Morgen-Mail aus einer Quelle', () => {
  it('Live-Test 13.10.: freigegebene Selbst-Posts und Verzeichnis-Einträge stehen erst an ihrem Tag unter "Du bist dran"', async () => {
    const com = await task({ code: 'BMX-COM-002', status: 'freigegeben', draftKind: 'post', channel: 'r/selfhosted', dueDate: '2026-10-14', dueTime: '14:00' })
    await draft(com.id, { status: 'freigegeben', approvedVia: 'mcp', approvedAt: new Date('2026-10-11T16:50:00Z'), releaseAt: new Date('2026-10-12T08:00:00Z') })
    const dir = await task({ code: 'BMX-DIR-002', category: 'verzeichnis', status: 'freigegeben', draftKind: 'text', channel: 'glama, mcp.so', dueDate: '2026-11-09', dueTime: '15:00', humanStep: 'Eintrag im Formular einreichen' })
    await draft(dir.id, { kind: 'text', status: 'freigegeben', approvedVia: 'mcp', approvedAt: new Date('2026-10-10T06:52:00Z'), releaseAt: new Date('2026-10-14T13:00:00Z') })
    const blog = await task({ code: 'BMX-CON-003', category: 'content', status: 'freigegeben', draftKind: 'article', channel: 'linkbox.com/blog', dueDate: '2026-11-12', dueTime: '10:00' })
    await draft(blog.id, { kind: 'article', status: 'freigegeben' })
    const today = await task({ code: 'BMX-COM-009', status: 'freigegeben', draftKind: 'post', channel: 'r/selfhosted', dueTime: '14:00' })
    await draft(today.id, { status: 'freigegeben' })
    const late = await task({ code: 'BMX-COM-010', status: 'entwurf_fertig', draftKind: 'post', agentStep: 'Entwurf', dueDate: '2026-10-12', dueTime: '09:00' })
    await draft(late.id)

    const l = await draftLists(db, ws, undefined)
    expect(l.yours.map(r => r.task.code).sort()).toEqual(['BMX-COM-009', 'BMX-COM-010'])
    expect(l.soon.map(r => r.task.code)).toEqual(['BMX-COM-002', 'BMX-DIR-002', 'BMX-CON-003'])
    expect(l.outgoing).toEqual([])
    expect(l.yours.find(r => r.task.code === 'BMX-COM-009')!.view.overdue).toBe(false)
    expect(l.yours.find(r => r.task.code === 'BMX-COM-010')!.view.overdue).toBe(true)
    expect(l.soon.every(r => !r.view.overdue)).toBe(true)

    const dash = await dashboardView(db, ws, null, peter)
    expect(dash.status.approvals).toBe(l.yours.length)
    expect(dash.status.overdue).toBe(1)
    expect(dash.today_tasks.map(i => i.code).sort()).toEqual(['BMX-COM-009', 'BMX-COM-010'])
    expect(dash.status.minutes).toBeGreaterThan(0)
    const views = await openTaskViews(db, ws)
    const [g] = await morningDigests(db, ws)
    expect(g!.minutes).toBe(dash.status.minutes)
    expect(g!.items).toHaveLength(views.filter(r => r.view.who === 'you' && r.view.now).length)
  })

  it('Termin verschoben: Einspruchsfrist und geplanter Post folgen dem Termin der Aufgabe', async () => {
    const t = await task({ projectId: vis, code: 'THE-SOC-011', category: 'social', status: 'freigegeben', draftKind: 'post', dueDate: '2026-10-15', dueTime: '18:00' })
    const x = await draft(t.id, { status: 'freigegeben', approvedVia: 'mcp', approvedAt: new Date('2026-10-12T11:47:00Z'), releaseAt: new Date('2026-10-15T16:00:00Z') })
    const [post] = await db.insert(schema.socialPosts).values({ workspaceId: ws.id, projectId: vis, taskId: t.id, draftId: x.id, provider: 'direct', profile: 'p', scheduledAt: new Date('2026-10-15T16:00:00Z') }).returning()
    await updateTask(db, t, { dueDate: '2026-10-20' }, { type: 'system' })
    const [x2] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, x.id))
    const [p2] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, post!.id))
    expect(x2!.releaseAt!.toISOString()).toBe('2026-10-20T16:00:00.000Z')
    expect(p2!.scheduledAt.toISOString()).toBe('2026-10-20T16:00:00.000Z')
    const l = await draftLists(db, ws, eq(schema.tasks.projectId, vis))
    expect(l.outgoing.map(r => [r.task.code, r.at?.toISOString()])).toEqual([['THE-SOC-011', '2026-10-20T16:00:00.000Z']])
  })

  it('"Seit gestern" je Projekt und nach wer: KI, Claude, du', async () => {
    const t = await task({ projectId: vis, title: 'Superposition 1/12' })
    const log = (action: string, actor: string, projectId: string) => db.insert(schema.activity).values({ workspaceId: ws.id, projectId, taskId: t.id, actor, action, detail: { title: 'x' }, createdAt: new Date('2026-10-13T06:00:00Z') })
    await log('social_posted', 'agent', vis)
    await log('mcp_approved', 'mcp', vis)
    await log('status:freigegeben', 'user', vis)
    await log('draft_created', 'agent', bmx)
    const p = (await db.select().from(schema.projects).where(eq(schema.projects.id, bmx)))[0]!
    const own = await aiDone(db, ws, p, { all: true, ids: [] }, d)
    expect(own.ai).toMatchObject({ drafted: 1, posted: 0 })
    expect(own.claude.checked).toBe(0)
    const all = await aiDone(db, ws, null, { all: true, ids: [] }, d)
    expect(all.ai).toMatchObject({ posted: 1, drafted: 1 })
    expect(all.claude.checked).toBe(1)
    expect(all.you.approved).toBe(1)
  })

  it('Berichte und Strategie zählen aus derselben Quelle: Kanal live, veröffentlicht zählt als erledigt', () => {
    const m = liveMatcher([{ projectId: 'p', title: 'Eintrag in der offiziellen MCP Registry', channel: null }, { projectId: 'p', title: 'Profil anlegen', channel: 'AlternativeTo' }])
    expect(m({ projectId: 'p', name: 'MCP Registry' })).toBe(true)
    expect(m({ projectId: 'p', name: 'AlternativeTo' })).toBe(true)
    expect(m({ projectId: 'q', name: 'MCP Registry' })).toBe(false)
    expect(m({ projectId: 'p', name: 'glama' })).toBe(false)
    expect(countsAsDone('wartet')).toBe(true)
    expect(countsAsDone('freigegeben')).toBe(false)
  })

  it('Konto-Aufgabe: "Lege ein Konto bei ... an", nicht "Such passende Threads"', () => {
    expect(accountPlace({ title: 'Konten anlegen für Reddit, HN, IH, PH', humanStep: null, channel: null }, null)).toBe('Reddit, HN, IH, PH')
    expect(accountPlace({ title: 'Community-Beitrag: Self-Hosting', humanStep: 'Prüfen und selbst posten', channel: 'r/selfhosted' }, 'r/selfhosted')).toBeNull()
    expect(todoOf({ status: 'geplant', category: 'community', out: 'self', owner: 'human', account: 'Reddit' })).toMatchObject({ key: 'do.account', params: { place: 'Reddit' }, min: 2 })
    expect(todoOf({ status: 'geplant', category: 'community', out: 'self', owner: 'human' }).key).toBe('do.communityAny')
  })

  it('Einzahl und Mehrzahl', () => {
    expect(plural(1, 'Aufgabe', 'Aufgaben')).toBe('1 Aufgabe')
    expect(plural(3, 'Aufgabe', 'Aufgaben')).toBe('3 Aufgaben')
    expect(plural(0, 'Aufgabe', 'Aufgaben')).toBe('0 Aufgaben')
  })
})
