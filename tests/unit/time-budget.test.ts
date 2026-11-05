import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { createTask } from '../../server/lib/tasks'
import { humanCosts, planByBudget } from '../../server/lib/time-budget'
import { bundleDigestText, morningDigests, runMorningMail, sendMorningDigest, type Digest } from '../../server/lib/morning-digest'
import { renderSystemMail } from '../../server/mail-templates'
import { dashboardView } from '../../server/services/views'
import { ORDER_HEAD } from '../../shared/utils/digest'
import { addDays } from '../../shared/utils/dates'
import { budgetOf } from '../../shared/utils/time-budget'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let peter: string
let p1: string
let n = 0
const d = '2026-10-13'
const prevNow = process.env.MA_NOW

async function task(o: Partial<typeof schema.tasks.$inferInsert>) {
  n++
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p1, code: `B-${String(n).padStart(3, '0')}`, title: `Aufgabe ${n}`, category: 'pflege', humanStep: 'Erledigen', assigneeUserId: peter, dueDate: d, ...o }).returning()
  return t!
}

async function withDraft(o: Partial<typeof schema.tasks.$inferInsert>, kind: 'post' | 'mail' = 'post') {
  const t = await task({ category: kind === 'mail' ? 'outreach' : 'social', agentStep: 'Entwurf', humanStep: 'Freigeben', draftKind: kind, status: 'entwurf_fertig', ...o })
  await db.insert(schema.drafts).values({ taskId: t.id, kind, body: 'x', byAgent: true, createdAt: new Date('2026-10-13T06:00:00Z') })
  return t
}

const reload = async () => new Map((await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, ws.id))).map(t => [t.code, t]))

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:00:00Z'
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', timezone: 'Europe/Vienna' }).returning())[0]!
  peter = (await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning())[0]!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: peter, role: 'owner' })
  p1 = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'a', name: 'A', code: 'AAA', icon: 'A' }).returning())[0]!.id
})
afterAll(async () => {
  process.env.MA_NOW = prevNow
  if (prevNow === undefined) delete process.env.MA_NOW
  await close()
})

describe('Zeitbudget', () => {
  it('Standard 15 Minuten, je Person einstellbar', () => {
    expect(budgetOf({}, peter)).toBe(15)
    expect(budgetOf({ timeBudget: { [peter]: 30 } }, peter)).toBe(30)
  })

  it('verteilt Menschenarbeit aufs Budget, Website-Aufgaben gehen an Claude, Unwichtiges fällt weg', async () => {
    const pinned = await task({ estimateMin: 5, createdByUserId: peter })
    const a = await task({ estimateMin: 10, prio: 'P1' })
    const b = await task({ estimateMin: 10 })
    const c = await withDraft({})
    const m = await withDraft({}, 'mail')
    const info = await withDraft({})
    await db.insert(schema.taskNotes).values({ taskId: info.id, byAgent: true, text: 'Info nötig: Welches Datum?', createdAt: new Date('2026-10-13T06:01:00Z') })
    const site = await createTask(db, { workspaceId: ws.id, projectId: p1, title: 'Seitentitel kürzen', category: 'pflege', description: `SEO\n\n${ORDER_HEAD}\nIm Code ...`, dueDate: d, estimateMin: 30, humanStep: 'Erledigen', assigneeUserId: peter })
    const big = await task({ estimateMin: 30, prio: 'P3' })
    const old = await task({ estimateMin: 5, prio: 'P3', dueDate: addDays(d, -20), plannedFor: addDays(d, -20) })
    const waits = await task({ status: 'wartet', estimateMin: 60 })

    expect(site.forClaude).toBe(true)
    const costs = await humanCosts(db, ws, [a, c, m, info, site, waits])
    expect(costs.get(a.id)).toMatchObject({ kind: 'self', min: 10 })
    expect(costs.get(c.id)).toMatchObject({ kind: 'approve', min: 1 })
    expect(costs.get(m.id)).toMatchObject({ kind: 'approve', min: 4 })
    expect(costs.get(info.id)).toMatchObject({ kind: 'info' })
    expect(costs.get(site.id)).toMatchObject({ kind: 'claude', min: 0 })
    expect(costs.get(waits.id)?.min).toBe(0)

    const r = await planByBudget(db, ws, d)
    const t = await reload()
    expect(t.get(pinned.code)!.dueDate).toBe(d)
    expect(t.get(a.code)!.dueDate).toBe(d)
    expect(t.get(b.code)!.dueDate).toBe('2026-10-14')
    expect(t.get(c.code)!.dueDate).toBe('2026-10-14')
    expect(t.get(m.code)!.dueDate).toBe('2026-10-14')
    expect(t.get(info.code)!.dueDate).toBe('2026-10-15')
    expect(t.get(b.code)!.plannedFor).toBe(d)
    expect(t.get(site.code)!.dueDate).toBe(d)
    expect(t.get(big.code)!.status).toBe('verworfen')
    expect(t.get(old.code)!.status).toBe('verworfen')
    expect(t.get(waits.code)!.status).toBe('wartet')
    expect(r).toMatchObject({ moved: 4, dropped: 2 })
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, big.id))
    expect(notes[0]!.text).toMatch(/^Fällt weg: .*15 Minuten/)
    const acts = await db.select().from(schema.activity).where(and(eq(schema.activity.workspaceId, ws.id), eq(schema.activity.action, 'budget_dropped')))
    expect(acts).toHaveLength(2)

    expect(await planByBudget(db, ws, d)).toMatchObject({ moved: 0, dropped: 0 })
  })

  it('Dashboard zeigt nur Minuten im Budget und was die KI erledigt hat', async () => {
    const v = await dashboardView(db, ws, null, peter)
    expect(v.status.minutes).toBe(15)
    expect(v.status.budget).toBe(15)
    expect(v.done.ai).toMatchObject({ moved: 4, dropped: 2 })
    const claude = v.today_tasks.filter(i => i.forClaude)
    expect(claude).toHaveLength(1)
  })

  it('Freigabe durch Claude: ohne verbundenes Konto bleibt das Selbst-Posten Menschenarbeit', async () => {
    const c = await withDraft({ dueDate: addDays(d, 3) })
    const w2 = { ...ws, settings: { mcpApprove: { enabled: true, kinds: ['social'] } } }
    expect((await humanCosts(db, w2, [c])).get(c.id)).toMatchObject({ kind: 'self', min: 3 })
  })

  it('eine Morgen-Nachricht je Person mit Links, nicht doppelt, nicht nachts', async () => {
    const [g] = await morningDigests(db, ws)
    expect(g!.minutes).toBe(15)
    expect(g!.items.map(i => i.url)).toEqual(expect.arrayContaining([expect.stringMatching(/\/p\/a\/aufgaben\/[0-9a-f-]{36}$/)]))
    expect(g!.items.some(i => i.title.includes('Seitentitel'))).toBe(false)
    expect(await sendMorningDigest(db, ws)).toBe(1)
    expect(await sendMorningDigest(db, ws)).toBe(0)
    const queued = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'morning_mail'))
    expect(queued).toHaveLength(1)
    expect(await runMorningMail(db, peter)).toBe(1)
    expect(await runMorningMail(db, peter)).toBe(0)
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'system_mail'))
    expect(jobs).toHaveLength(1)
    expect(JSON.stringify(jobs[0]!.payload)).toContain('Heute für dich')
    process.env.MA_NOW = '2026-10-14T19:30:00Z'
    expect(await sendMorningDigest(db, ws)).toBe(0)
    process.env.MA_NOW = '2026-10-13T08:00:00Z'
  })

  it('mehrere Arbeitsbereiche: eine Mail je Person, ein Abschnitt je Bereich, Minuten addiert', async () => {
    const ws2 = (await db.insert(schema.workspaces).values({ name: 'Zweiter Bereich', timezone: 'Europe/Vienna' }).returning())[0]!
    await db.insert(schema.memberships).values({ workspaceId: ws2.id, userId: peter, role: 'owner' })
    const p2 = (await db.insert(schema.projects).values({ workspaceId: ws2.id, slug: 'b', name: 'B', code: 'BBB', icon: 'B' }).returning())[0]!.id
    await db.insert(schema.tasks).values({ workspaceId: ws2.id, projectId: p2, code: 'B-900', title: 'Im zweiten Bereich', category: 'pflege', humanStep: 'Erledigen', assigneeUserId: peter, dueDate: d, estimateMin: 5 })
    await db.delete(schema.notifications)
    await db.delete(schema.jobs)
    const before = (await morningDigests(db, ws)).find(g => g.userId === peter)!.minutes
    expect(await sendMorningDigest(db, ws)).toBe(1)
    expect(await sendMorningDigest(db, ws2)).toBe(1)
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'morning_mail'))).toHaveLength(1)
    expect(await runMorningMail(db, peter)).toBe(1)
    const mails = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'system_mail'))
    expect(mails).toHaveLength(1)
    const vars = (mails[0]!.payload as { vars: { subject: string, body: string } }).vars
    expect(vars.subject).toBe(`Heute für dich: ca. ${before + 5} Minuten`)
    expect(vars.body).toContain('## Test\n')
    expect(vars.body).toContain('## Zweiter Bereich\n')
    expect(vars.body).toContain('Im zweiten Bereich')
    expect(vars.subject).not.toMatch(/\[/)
    const html = renderSystemMail('generic-notice', vars, 'de').html
    expect(html).toContain('font-weight:700;color:#111">Zweiter Bereich</p>')
    const one = { userId: peter, minutes: 3, items: [{ title: 'X', time: null, min: 3, url: 'u' }] } as Digest
    const empty = { userId: peter, minutes: 0, items: [] } as Digest
    expect(bundleDigestText([{ workspace: 'A', digest: one }, { workspace: 'B', digest: empty }], 'de')!.body).not.toContain('##')
    expect(bundleDigestText([{ workspace: 'A', digest: empty }], 'de')).toBeNull()
  })

  it('Verschoben zählt jede Aufgabe einmal, auch wenn die Planung sie mehrmals weiterschiebt', async () => {
    const before = (await dashboardView(db, ws, null, peter)).done.ai.moved
    await db.insert(schema.activity).values([
      { workspaceId: ws.id, actor: 'agent', action: 'budget_planned', detail: { moved: 2, dropped: 0, ids: ['t1', 't2'] }, createdAt: new Date() },
      { workspaceId: ws.id, actor: 'agent', action: 'budget_planned', detail: { moved: 2, dropped: 0, ids: ['t2', 't3'] }, createdAt: new Date() },
    ])
    expect((await dashboardView(db, ws, null, peter)).done.ai.moved).toBe(before + 3)
  })
})
