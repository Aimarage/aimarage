import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { closeConnectedSetups, setupPlatforms } from '../../server/lib/plan-guard'
import { resetSecretCache } from '../../server/lib/secret'

let db: Db
let close: () => Promise<void>

beforeAll(async () => {
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
})
afterAll(async () => {
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Einrichtungs-Aufgaben mit verbundenem Konto', () => {
  it('erkennt Konto- und Profil-Aufgaben, nicht Reddit oder anderes', () => {
    expect(setupPlatforms({ title: 'Profile anlegen: Mastodon (z.B. @peter@mastodon.social), Bluesky', origin: null })).toEqual(['mastodon', 'bluesky'])
    expect(setupPlatforms({ title: 'Konto anlegen: X für chatsite', origin: 'setup:account:x' })).toEqual(['x'])
    expect(setupPlatforms({ title: 'Reddit-Konto anlegen', origin: null })).toBeNull()
    expect(setupPlatforms({ title: 'Post auf Mastodon: Release', origin: null })).toBeNull()
  })

  it('schließt offene Aufgaben mit Notiz, wenn das Konto verbunden ist', async () => {
    const [ws] = await db.insert(schema.workspaces).values({ name: 'Test' }).returning()
    const [p, q] = await db.insert(schema.projects).values([{ workspaceId: ws!.id, slug: 'tv', name: 'TV', code: 'TVL', icon: 'T' }, { workspaceId: ws!.id, slug: 'bm', name: 'BM', code: 'BMX', icon: 'B' }]).returning()
    const conn = await upsertConnection(db, ws!.id, { provider: 'bluesky', platform: 'bluesky', name: '@tv', handle: 'tv.bsky.social', ext: { did: 'did:plc:tv' } }, { identifier: 'tv.bsky.social', password: 'app-pass' }, { projectId: p!.id })
    await db.update(schema.projects).set({ setup: { social: { accountIds: [conn.id] } } }).where(eq(schema.projects.id, p!.id))
    const base = { workspaceId: ws!.id, category: 'pflege' as const, dueDate: '2026-10-12' }
    const rows = await db.insert(schema.tasks).values([
      { ...base, projectId: p!.id, code: 'TVL-PFL-001', title: 'Konto anlegen: Bluesky für TV', origin: 'setup:account:bluesky' },
      { ...base, projectId: q!.id, code: 'BMX-PFL-001', title: 'Konto anlegen: Bluesky für BM', origin: 'setup:account:bluesky' },
      { ...base, projectId: null, code: 'F-03', title: 'Profil anlegen: Bluesky', category: 'social', status: 'entwurf_fertig' },
      { ...base, projectId: null, code: 'F-09', title: 'Profile anlegen: Bluesky, Mastodon' },
    ]).returning()
    const fresh = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws!.id)))[0]!
    expect(await closeConnectedSetups(db, fresh)).toBe(2)
    const st = new Map((await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, ws!.id))).map(t => [t.code, t.status]))
    expect(Object.fromEntries(st)).toEqual({ 'TVL-PFL-001': 'erledigt', 'BMX-PFL-001': 'geplant', 'F-03': 'erledigt', 'F-09': 'geplant' })
    const [note] = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, rows[0]!.id))
    expect(note!.text).toContain('schon verbunden')
  })
})
