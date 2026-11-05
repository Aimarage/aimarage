import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { chatTitle, findConversation, listConversations, newConversation, queueUserMessage, type ChatActor } from '../../server/lib/chat'

let db: Db
let close: () => Promise<void>
let actor: ChatActor
let projectId: string

beforeAll(async () => {
  ;({ db, close } = await openTestDb())
  const ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  const userId = (await db.insert(schema.users).values({ email: 'p@test.local', name: 'Peter' }).returning())[0]!.id
  projectId = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'visitors', name: 'Visitors', code: 'THE', icon: 'music' }).returning())[0]!.id
  actor = { workspace: ws, userId, userName: 'Peter', role: 'owner', access: { all: true, ids: [] } }
})
afterAll(async () => {
  await close()
})

describe('Mehrere Chats', () => {
  it('Titel aus der ersten Nachricht', () => {
    expect(chatTitle('[2 Dateien hochgeladen]\nWie läuft es?')).toBe('Wie läuft es?')
    expect(chatTitle('a '.repeat(50))!.length).toBeLessThanOrEqual(60)
  })
  it('bestehender Verlauf bleibt erster Chat, neuer Chat wird Standard, leerer wird wiederverwendet', async () => {
    const first = (await findConversation(db, actor, projectId, { create: true }))!
    await queueUserMessage(db, actor, first, 'Wie läuft es diese Woche?')
    const second = await newConversation(db, actor, projectId)
    expect(second.id).not.toBe(first.id)
    expect((await newConversation(db, actor, projectId)).id).toBe(second.id)
    expect((await findConversation(db, actor, projectId))!.id).toBe(second.id)
    const list = await listConversations(db, actor, projectId)
    expect(list.map(c => c.id)).toEqual([second.id, first.id])
    expect(list[1]).toMatchObject({ title: 'Wie läuft es diese Woche?', empty: false })
    expect(await listConversations(db, actor, null)).toEqual([])
  })
})
