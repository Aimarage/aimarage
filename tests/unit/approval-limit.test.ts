import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { approvedUntil, draftBudget, shortDay, spreadDraftTasks } from '../../server/lib/approval-limit'
import { digestText } from '../../server/lib/morning-digest'
import { queueDueDrafts } from '../../server/lib/agent'
import { today } from '../../server/lib/clock'
import { addDays } from '../../shared/utils/dates'
import { dashboardView } from '../../server/services/views'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let peter: string
let p1: string
let n = 0
const d = today('Europe/Vienna')

async function task(o: Partial<typeof schema.tasks.$inferInsert> & { dueDate: string }) {
  n++
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p1, code: `D-${String(n).padStart(3, '0')}`, title: `Post ${n}`, category: 'social', agentStep: 'Entwurf', humanStep: 'Freigeben', draftKind: 'post', assigneeUserId: peter, ...o }).returning()
  return t!
}

async function draft(taskId: string) {
  await db.insert(schema.drafts).values({ taskId, kind: 'post', body: 'x', byAgent: true })
  await db.update(schema.tasks).set({ status: 'entwurf_fertig' }).where(eq(schema.tasks.id, taskId))
}

const dates = async () => new Map((await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, ws.id))).map(t => [t.code, t.dueDate]))

beforeAll(async () => {
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', timezone: 'Europe/Vienna' }).returning())[0]!
  peter = (await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning())[0]!.id
  p1 = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'a', name: 'A', code: 'AAA', icon: 'A' }).returning())[0]!.id
})
afterAll(async () => {
  await close()
})

describe('Freigaben-Tageslimit', () => {
  it('höchstens 5 Entwurfs-Aufgaben je Tag, Überfällige rücken nach, Feste bleiben', async () => {
    const t1 = addDays(d, 1)
    const many = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => task({ dueDate: t1 })))
    const late = await task({ dueDate: addDays(d, -3) })
    const fixed = await task({ dueDate: t1, dueTime: '09:00' })
    const self = await task({ dueDate: t1, agentStep: null, draftKind: null })
    const moved = await spreadDraftTasks(db, ws, d)
    const m = await dates()
    expect(m.get(late.code)).toBe(d)
    expect(m.get(fixed.code)).toBe(t1)
    expect(m.get(self.code)).toBe(t1)
    expect(many.filter(t => m.get(t.code) === t1)).toHaveLength(4)
    expect(many.filter(t => m.get(t.code) === addDays(d, 2))).toHaveLength(3)
    expect(moved).toBe(1 + 3)
    expect(await spreadDraftTasks(db, ws, d)).toBe(0)
  })

  it('schreibt Entwürfe mit Vorlauf, gestaffelt nach Tagesbudget, wartende Jobs zählen', async () => {
    const first = await db.select().from(schema.tasks).where(eq(schema.tasks.dueDate, d))
    await draft(first[0]!.id)
    expect(await draftBudget(db, ws, d)).toEqual({ total: 14, ahead: 10 })
    expect(await queueDueDrafts(db, ws, d)).toBe(8)
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))
    const due = new Map((await db.select().from(schema.tasks)).map(t => [t.id, t.dueDate]))
    expect(jobs.every(j => due.get(String(j.payload.taskId))! <= addDays(d, 7))).toBe(true)
    expect(jobs.filter(j => due.get(String(j.payload.taskId))! > addDays(d, 1))).toHaveLength(3)
    expect(await draftBudget(db, ws, d)).toEqual({ total: 6, ahead: 6 })
    expect(await queueDueDrafts(db, ws, d)).toBe(0)
    await db.delete(schema.jobs)
  })

  it('Vorlauf je Projekt, Antworten und Community nur bis morgen, Vorlauf höchstens doppeltes Limit', async () => {
    const [w2] = await db.insert(schema.workspaces).values({ name: 'Vorlauf', timezone: 'Europe/Vienna', settings: { approvalsPerDay: 2 } }).returning()
    const [pa] = await db.insert(schema.projects).values({ workspaceId: w2!.id, slug: 'kurz', name: 'Kurz', code: 'KRZ', icon: 'K', setup: { draftAhead: 2 } }).returning()
    const [pb] = await db.insert(schema.projects).values({ workspaceId: w2!.id, slug: 'lang', name: 'Lang', code: 'LNG', icon: 'L' }).returning()
    const mk = async (projectId: string, dueDate: string, o: Partial<typeof schema.tasks.$inferInsert> = {}) => {
      n++
      return (await db.insert(schema.tasks).values({ workspaceId: w2!.id, projectId, code: `V-${n}`, title: `Post ${n}`, category: 'social', agentStep: 'Entwurf', draftKind: 'post', dueDate, ...o }).returning())[0]!
    }
    const shortOut = await mk(pa!.id, addDays(d, 4))
    const shortIn = await mk(pa!.id, addDays(d, 2))
    const community = await mk(pb!.id, addDays(d, 3), { category: 'community', title: 'Antwort im Forum' })
    const far = await Promise.all([3, 4, 5, 6, 7].map(i => mk(pb!.id, addDays(d, i))))
    const beyond = await mk(pb!.id, addDays(d, 8))
    const ws2 = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w2!.id)))[0]!
    expect(await draftBudget(db, ws2, d)).toEqual({ total: 6, ahead: 4 })
    expect(await queueDueDrafts(db, ws2, d)).toBe(4)
    const queued = new Set((await db.select().from(schema.jobs).where(eq(schema.jobs.workspaceId, w2!.id))).map(j => String(j.payload.taskId)))
    expect(queued.has(shortIn.id)).toBe(true)
    expect(queued.has(shortOut.id)).toBe(false)
    expect(queued.has(community.id)).toBe(false)
    expect(queued.has(beyond.id)).toBe(false)
    expect(far.filter(t => queued.has(t.id))).toHaveLength(3)
    await db.delete(schema.jobs)
  })

  it('Serienteile behalten ihre Reihenfolge und den Abstand von 3 Stunden', async () => {
    const [w3] = await db.insert(schema.workspaces).values({ name: 'Serie', timezone: 'Europe/Vienna' }).returning()
    const [ps] = await db.insert(schema.projects).values({ workspaceId: w3!.id, slug: 'serie', name: 'Serie', code: 'SER', icon: 'S' }).returning()
    const part = async (i: number, dueDate: string) => (await db.insert(schema.tasks).values({ workspaceId: w3!.id, projectId: ps!.id, code: `SER-${i}`, title: `Album-Serie ${i}/5: Track ${i}`, category: 'social', agentStep: 'Entwurf', draftKind: 'post', dueDate, dueTime: '18:00', createdByUserId: peter }).returning())[0]!
    await part(1, addDays(d, -3))
    await part(2, addDays(d, -2))
    await part(3, addDays(d, 1))
    await part(4, addDays(d, 2))
    await part(5, addDays(d, 4))
    const ws3 = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w3!.id)))[0]!
    expect(await spreadDraftTasks(db, ws3, d)).toBeGreaterThan(0)
    const rows = (await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, w3!.id))).sort((a, b) => a.code.localeCompare(b.code))
    const at = rows.map(r => `${r.dueDate} ${r.dueTime}`)
    for (let i = 1; i < at.length; i++) expect(at[i]! > at[i - 1]!).toBe(true)
    expect(rows[0]!.dueDate! >= d).toBe(true)
    for (const a of rows) {
      for (const b of rows) {
        if (a.id === b.id || a.dueDate !== b.dueDate) continue
        const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
        expect(Math.abs(m(a.dueTime!) - m(b.dueTime!))).toBeGreaterThanOrEqual(180)
      }
    }
    expect(await spreadDraftTasks(db, ws3, d)).toBe(0)
  })

  it('Freigegeben bis: Tag vor der ersten offenen Freigabe, in der Morgen-Mail', async () => {
    const [w4] = await db.insert(schema.workspaces).values({ name: 'Bis', timezone: 'Europe/Vienna' }).returning()
    const [p4] = await db.insert(schema.projects).values({ workspaceId: w4!.id, slug: 'bis', name: 'Bis', code: 'BIS', icon: 'B' }).returning()
    const mk = async (dueDate: string, status: 'geplant' | 'entwurf_fertig' | 'freigegeben') => {
      n++
      await db.insert(schema.tasks).values({ workspaceId: w4!.id, projectId: p4!.id, code: `B-${n}`, title: `Post ${n}`, category: 'social', agentStep: 'Entwurf', humanStep: 'Freigeben', draftKind: 'post', assigneeUserId: peter, dueDate, status })
    }
    const ws4 = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w4!.id)))[0]!
    expect(await approvedUntil(db, ws4, d)).toBeNull()
    await mk(d, 'freigegeben')
    await mk(addDays(d, 2), 'freigegeben')
    expect(await approvedUntil(db, ws4, d)).toBe(addDays(d, 2))
    await mk(addDays(d, 5), 'entwurf_fertig')
    expect(await approvedUntil(db, ws4, d)).toBe(addDays(d, 4))
    await mk(d, 'geplant')
    expect(await approvedUntil(db, ws4, d)).toBeNull()
    expect(shortDay('2026-10-29', 'de')).toBe('Do 29.10.')
    expect(digestText({ userId: 'x', minutes: 2, items: [{ title: 'Post', time: null, min: 2, url: 'u' }], approvedUntil: '2026-10-29' }, 'de').body).toContain('Bis Do 29.10. ist alles freigegeben.')
  })

  it('Dashboard zählt nur bald fällige Freigaben und überfällige Aufgaben von Peter', async () => {
    const later = await task({ dueDate: addDays(d, 5) })
    await draft(later.id)
    await task({ dueDate: addDays(d, -2), agentStep: null, draftKind: null, title: 'Selbst' })
    await task({ dueDate: addDays(d, -2), assigneeUserId: null, draftKind: null, title: 'Agent' })
    const dash = await dashboardView(db, ws, null, peter)
    expect(dash.status.approvals).toBe(1)
    expect(dash.status.overdue).toBe(1)
  })

  it('Dashboard zeigt keinen Briefing-Fließtext und stößt kein neues Briefing an', async () => {
    await db.insert(schema.reports).values({ workspaceId: ws.id, kind: 'briefing', periodStart: d, periodEnd: d, content: { todayTitles: ['Anderes Projekt: Superposition'] }, text: 'Schwerpunkt Superposition' })
    const dash = await dashboardView(db, ws, null, peter)
    expect('briefing' in dash).toBe(false)
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'daily_briefing'))).toHaveLength(0)
  })
})
