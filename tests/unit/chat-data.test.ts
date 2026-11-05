import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { inboxEntries, pageContext, readItem, searchAll, type DataActor } from '../../server/lib/chat-data'

let db: Db
let close: () => Promise<void>
let a: DataActor
let mailId: string

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-31T09:00:00+01:00'
  ;({ db, close } = await openTestDb())
  const ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  const other = (await db.insert(schema.workspaces).values({ name: 'Fremd' }).returning())[0]!
  const p = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'visitors', name: 'Visitors', code: 'THE', icon: 'music', setup: { mail: { imap: {}, smtp: {}, from: 'band@x.example' } as never } }).returning())[0]!
  const q = (await db.insert(schema.projects).values({ workspaceId: other.id, slug: 'fremd', name: 'Fremd', code: 'FRE', icon: 'music', setup: { mail: { imap: {}, smtp: {}, from: 'f@x.example' } as never } }).returning())[0]!
  const at = new Date('2026-10-30T10:00:00Z')
  mailId = (await db.insert(schema.mails).values({ workspaceId: ws.id, projectId: p.id, direction: 'in', messageId: '<m1@x>', fromAddr: 'mello@lofi.example', fromName: 'Mr Mello', subject: 'A Little Support Goes a Long Way!', body: 'Please stream', category: 'antwort', createdAt: at, sentAt: at }).returning())[0]!.id
  await db.insert(schema.mails).values({ workspaceId: other.id, projectId: q.id, direction: 'in', messageId: '<m2@x>', fromAddr: 'mello@lofi.example', subject: 'Mello fremd', category: 'antwort', createdAt: at })
  await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p.id, code: 'THE-SOC-001', title: 'Post über Mello Beats', category: 'social', dueDate: '2026-10-31' })
  a = { workspaceId: ws.id, access: { all: true, ids: [] }, role: 'owner' }
})
afterAll(async () => {
  delete process.env.MA_NOW
  await close()
})

describe('Chat-Daten', () => {
  it('Postfach nur im eigenen Arbeitsbereich und erst ab Admin', async () => {
    const list = await inboxEntries(db, a)
    expect(list.map(m => m.id)).toEqual([mailId])
    expect(list[0]).toMatchObject({ state: 'braucht Antwort', category: 'antwort' })
    expect(await inboxEntries(db, { ...a, role: 'member' })).toEqual([])
  })
  it('Seitenkontext Postfach zeigt die sichtbaren Mails mit id', async () => {
    const t = await pageContext(db, a, '/p/visitors/postfach')
    expect(t).toContain(`[id ${mailId}]`)
    expect(t).toContain('Mr Mello')
    expect(await pageContext(db, a, '/p/fremd/postfach')).not.toContain('Mello fremd')
  })
  it('Suche über Bereiche, ohne fremde Arbeitsbereiche', async () => {
    const hits = await searchAll(db, a, 'mello')
    expect(hits.map(h => h.type).sort()).toEqual(['aufgabe', 'mail'])
    expect(hits.some(h => h.title.includes('fremd'))).toBe(false)
    expect((await readItem(db, a, 'aufgabe', 'the-soc-001') as { code: string }).code).toBe('THE-SOC-001')
    expect(await readItem(db, a, 'mail', mailId)).toMatchObject({ subject: 'A Little Support Goes a Long Way!' })
  })
})
