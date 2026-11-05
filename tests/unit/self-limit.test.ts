import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { spreadSelfTasks } from '../../server/lib/self-limit'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let peter: string
let anna: string
let p1: string
let p2: string
let n = 0

async function task(o: Partial<typeof schema.tasks.$inferInsert> & { dueDate: string }) {
  n++
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: n % 2 ? p1 : p2, code: `T-${String(n).padStart(3, '0')}`, title: `Aufgabe ${n}`, category: 'pflege', humanStep: 'Erledigen', assigneeUserId: peter, ...o }).returning()
  return t!
}

const dates = async () => new Map((await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, ws.id))).map(t => [t.code, t.dueDate]))

beforeAll(async () => {
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  const users = await db.insert(schema.users).values([{ email: 'peter@test.local', name: 'Peter' }, { email: 'anna@test.local', name: 'Anna' }]).returning()
  peter = users[0]!.id
  anna = users[1]!.id
  const ps = await db.insert(schema.projects).values([{ workspaceId: ws.id, slug: 'a', name: 'A', code: 'AAA', icon: 'A' }, { workspaceId: ws.id, slug: 'b', name: 'B', code: 'BBB', icon: 'B' }]).returning()
  p1 = ps[0]!.id
  p2 = ps[1]!.id
})
afterAll(async () => {
  await close()
})

describe('Tageslimit für Selbst-Aufgaben', () => {
  it('höchstens 3 pro Tag und Person über alle Projekte, Überschuss nach Priorität auf die nächsten Werktage', async () => {
    const fri = '2026-10-16'
    const p1s = [await task({ dueDate: fri, prio: 'P1' }), await task({ dueDate: fri, prio: 'P1' })]
    const p2s = await Promise.all([1, 2, 3].map(() => task({ dueDate: fri, prio: 'P2' })))
    const late = await task({ dueDate: '2026-10-09', prio: 'P3' })
    const fixed = await task({ dueDate: fri, dueTime: '10:00' })
    const mine = await task({ dueDate: '2026-10-19', createdByUserId: peter })
    const agent = await task({ dueDate: fri, agentStep: 'Entwurf', draftKind: 'text' })
    const other = await Promise.all([1, 2, 3, 4].map(() => task({ dueDate: fri, assigneeUserId: anna })))
    const moved = await spreadSelfTasks(db, ws, '2026-10-12')
    const d = await dates()
    expect(d.get(late.code)).toBe('2026-10-12')
    expect(d.get(fixed.code)).toBe(fri)
    for (const t of p1s) expect(d.get(t.code)).toBe(fri)
    const count = (day: string) => [...p1s, ...p2s, fixed, late, mine].filter(t => d.get(t.code) === day).length
    expect(count(fri)).toBe(3)
    expect(p2s.map(t => d.get(t.code))).toEqual(['2026-10-19', '2026-10-19', '2026-10-20'])
    expect(count('2026-10-19')).toBe(3)
    expect(d.get(mine.code)).toBe('2026-10-19')
    expect(d.get(agent.code)).toBe(fri)
    expect(other.filter(t => d.get(t.code) === fri)).toHaveLength(3)
    expect(moved).toBe(1 + 3 + 1)
    expect(await spreadSelfTasks(db, ws, '2026-10-12')).toBe(0)
  })

  it('Limit ist je Arbeitsbereich einstellbar', async () => {
    await db.update(schema.workspaces).set({ settings: { selfPerDay: 1 } }).where(eq(schema.workspaces.id, ws.id))
    ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
    const d0 = await dates()
    await spreadSelfTasks(db, ws, '2026-10-12')
    const d = await dates()
    const annaDays = [...d.entries()].filter(([c]) => Number(c.slice(2)) >= 10).map(([, v]) => v)
    expect(new Set(annaDays).size).toBe(4)
    expect(d0.size).toBe(d.size)
  })
})
