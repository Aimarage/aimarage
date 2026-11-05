import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectAccess, type Access } from '../../server/lib/access'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { materializeRecurrences } from '../../server/lib/materialize'
import { endRecurrence, loadRecurrence } from '../../server/lib/recurrences'

let db: Db
let close: () => Promise<void>
let wsId: string
let otherWsId: string
let peterId: string
let access: Access
let otherAccess: Access
let recId: string

const byDate = async () => {
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.recurrenceId, recId))
  return new Map(rows.map(r => [r.dueDate!, r]))
}

beforeAll(async () => {
  ({ db, close } = await openTestDb())
  const [w, o] = await db.insert(schema.workspaces).values([{ name: 'Test' }, { name: 'Fremd' }]).returning()
  wsId = w!.id
  otherWsId = o!.id
  const [peter, eve] = await db.insert(schema.users).values([{ email: 'peter@test.local', name: 'Peter' }, { email: 'eve@test.local', name: 'Eve' }]).returning()
  peterId = peter!.id
  await db.insert(schema.memberships).values([{ workspaceId: wsId, userId: peterId, role: 'owner' }, { workspaceId: otherWsId, userId: eve!.id, role: 'owner' }])
  const [p] = await db.insert(schema.projects).values({ workspaceId: wsId, slug: 'chatsite', name: 'chatsite', code: 'AMW', icon: 'box' }).returning()
  const [rec] = await db.insert(schema.recurrences).values({ workspaceId: wsId, projectId: p!.id, rule: 'weekly:WE', title: 'LinkedIn-Fachpost', category: 'social', channel: 'LinkedIn', draftKind: 'post' }).returning()
  recId = rec!.id
  access = await projectAccess(db, { workspaceId: wsId, userId: peterId, role: 'owner' })
  otherAccess = await projectAccess(db, { workspaceId: otherWsId, userId: eve!.id, role: 'owner' })
  await materializeRecurrences(db, wsId, '2026-10-01', 27)
})
afterAll(() => close())

describe('Serie beenden', () => {
  it('fremder Arbeitsbereich findet die Serie nicht', async () => {
    expect(await loadRecurrence(db, otherWsId, otherAccess, recId)).toBeNull()
    expect(await loadRecurrence(db, wsId, access, 'unsinn')).toBeNull()
    expect((await loadRecurrence(db, wsId, access, recId))?.id).toBe(recId)
  })

  it('beendet, verwirft künftige offene Aufgaben, Vergangenes und Freigegebenes bleibt', async () => {
    const before = await byDate()
    expect([...before.keys()].sort()).toEqual(['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28'])
    const approved = before.get('2026-10-14')!
    const ready = before.get('2026-10-21')!
    await db.insert(schema.drafts).values([
      { taskId: approved.id, version: 1, kind: 'post', body: 'Freigegeben', status: 'freigegeben' },
      { taskId: ready.id, version: 1, kind: 'post', body: 'Offen' },
    ])
    await db.update(schema.tasks).set({ status: 'freigegeben' }).where(eq(schema.tasks.id, approved.id))
    await db.update(schema.tasks).set({ status: 'entwurf_fertig' }).where(eq(schema.tasks.id, ready.id))

    const rec = (await loadRecurrence(db, wsId, access, recId))!
    const r = await endRecurrence(db, rec, '2026-10-12', { type: 'user', userId: peterId })
    expect(r.discarded.sort()).toEqual([ready.code, before.get('2026-10-28')!.code].sort())

    const after = await byDate()
    expect(after.get('2026-10-07')!.status).toBe('geplant')
    expect(after.get('2026-10-14')!.status).toBe('freigegeben')
    expect(after.get('2026-10-21')!.status).toBe('verworfen')
    expect(after.get('2026-10-28')!.status).toBe('verworfen')
    const [d] = await db.select().from(schema.drafts).where(and(eq(schema.drafts.taskId, ready.id)))
    expect(d!.status).toBe('ersetzt')
    const [row] = await db.select().from(schema.recurrences).where(eq(schema.recurrences.id, recId))
    expect(row!.active).toBe(false)
    expect(row!.untilDate).toBe('2026-10-12')
  })

  it('legt danach keine neuen Termine mehr an, auch wenn wieder aktiv', async () => {
    expect(await materializeRecurrences(db, wsId, '2026-10-12', 60)).toBe(0)
    await db.update(schema.recurrences).set({ active: true }).where(eq(schema.recurrences.id, recId))
    expect(await materializeRecurrences(db, wsId, '2026-10-12', 60)).toBe(0)
    expect((await byDate()).size).toBe(4)
  })
})
