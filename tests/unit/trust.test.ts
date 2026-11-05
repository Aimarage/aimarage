import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { buildBlogApi } from '../../server/lib/blog-api'
import { resetSecretCache } from '../../server/lib/secret'
import { decisions, suggestKinds, trustSuggestions } from '../../server/lib/trust'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let userId: string
let seq = 0

async function decided(opts: { edited?: boolean, rejected?: boolean, at: string }) {
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `TR-${++seq}`, title: `Artikel ${seq}`, category: 'content', status: 'erledigt', draftKind: 'article' }).returning()
  const at = new Date(opts.at)
  if (opts.rejected) {
    await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'article', body: 'x', status: 'verworfen', byAgent: true, createdAt: at })
    return
  }
  if (opts.edited) await db.insert(schema.drafts).values({ taskId: t!.id, version: 1, kind: 'article', body: 'x', status: 'ersetzt', byAgent: true, createdAt: at })
  await db.insert(schema.drafts).values({ taskId: t!.id, version: opts.edited ? 2 : 1, kind: 'article', body: 'y', status: 'freigegeben', byAgent: !opts.edited, createdByUserId: opts.edited ? userId : null, approvedByUserId: userId, approvedAt: at, createdAt: at })
}

beforeAll(async () => {
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  userId = (await db.insert(schema.users).values({ email: 'p@test.local', name: 'Peter' }).returning())[0]!.id
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'amw', name: 'chatsite', code: 'AMW', icon: 'chat' }).returning())[0]!
})
afterAll(async () => {
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Vorschlag: künftig direkt raus', () => {
  it('nur bei 5 unverändert freigegebenen in Folge und vorhandenem Ausgang', () => {
    const d = (i: number, clean = true) => ({ taskId: `t${i}`, kind: 'social' as const, at: new Date(2026, 9, i), clean })
    const five = [1, 2, 3, 4, 5].map(i => d(i))
    const outlets = { social: true, content: false, mail: false }
    expect(suggestKinds(five, { autonomy: {}, setup: {} }, outlets)).toEqual(['social'])
    expect(suggestKinds(five, { autonomy: {}, setup: {} }, { ...outlets, social: false })).toEqual([])
    expect(suggestKinds(five, { autonomy: { social: 'auto_report' }, setup: {} }, outlets)).toEqual([])
    expect(suggestKinds([...five.slice(0, 4), d(5, false)], { autonomy: {}, setup: {} }, outlets)).toEqual([])
    expect(suggestKinds(five, { autonomy: {}, setup: { trustAsked: { social: new Date(2026, 9, 3).toISOString() } } }, outlets)).toEqual([])
    const rows = [
      { taskId: 'a', category: 'social', draftKind: 'post', status: 'freigegeben', byAgent: true, approvedBy: 'u', approvedAt: new Date(), createdAt: new Date() },
      { taskId: 'b', category: 'social', draftKind: 'post', status: 'freigegeben', byAgent: false, approvedBy: 'u', approvedAt: new Date(), createdAt: new Date() },
      { taskId: 'c', category: 'social', draftKind: 'post', status: 'freigegeben', byAgent: true, approvedBy: null, approvedAt: new Date(), createdAt: new Date() },
    ]
    expect(decisions(rows).map(x => [x.taskId, x.clean])).toEqual([['a', true], ['b', false]])
  })

  it('aus der Datenbank: Artikel mit Zugang zum Veröffentlichen', async () => {
    for (let i = 1; i <= 5; i++) await decided({ at: `2026-10-0${i}T10:00:00Z` })
    expect(await trustSuggestions(db, ws, project)).toEqual([])
    await db.update(schema.projects).set({ setup: { blogApi: buildBlogApi(ws.id, project.id, null, { url: 'https://a.example/api/guides', token: 'token-12345678' }) } }).where(eq(schema.projects.id, project.id))
    project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
    expect(await trustSuggestions(db, ws, project)).toEqual(['content'])
    await decided({ edited: true, at: '2026-10-06T10:00:00Z' })
    expect(await trustSuggestions(db, ws, project)).toEqual([])
    for (let i = 7; i <= 9; i++) await decided({ at: `2026-10-0${i}T10:00:00Z` })
    await decided({ rejected: true, at: '2026-10-09T12:00:00Z' })
    expect(await trustSuggestions(db, ws, project)).toEqual([])
  })
})
