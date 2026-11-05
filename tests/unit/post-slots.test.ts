import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { namedPlatforms, platformOf, taskListedPlatforms } from '../../shared/utils/drafting'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { freeSlot, postPlatforms } from '../../server/lib/post-slots'
import { targetAccounts, type SocialTarget } from '../../server/lib/publish'
import { createTask, updateTask } from '../../server/lib/tasks'
import { withChannelPlaces } from '../../server/lib/channel-places'
import { runToolDirect, type ChatActor } from '../../server/lib/chat'

describe('Plattformen aus Titel und Beschreibung', () => {
  const t021 = { title: 'Post: Frage an KI-Musiker - würdet ihr offen gekennzeichnet verkaufen? (Mastodon + Bluesky)', category: 'social', channel: null, targetUrl: null, description: 'Kurzer Fragepost auf Mastodon (#indiemusic) und Bluesky, Englisch.' }
  const target = { cfg: {} as SocialTarget['cfg'], profile: null, platforms: [
    { platform: 'x', name: '@tonebase', postable: true, via: 'c0' },
    { platform: 'bluesky', name: '@tonebase.bsky.social', postable: true, via: 'c1' },
    { platform: 'mastodon', name: '@tonebase@mastodon.social', postable: true, via: 'c2' },
  ] } satisfies SocialTarget

  it('Titel "(Mastodon + Bluesky)" ohne Kanal: nur diese beiden, kein X', () => {
    expect(taskListedPlatforms(t021)).toEqual(['bluesky', 'mastodon'])
    expect(platformOf(t021)).toBeNull()
    expect(targetAccounts(target, t021).map(a => a.platform)).toEqual(['bluesky', 'mastodon'])
  })

  it('Kanal "Social Media (Mastodon/Bluesky)" zählt als Liste', () => {
    expect(targetAccounts(target, { ...t021, title: 'Social-Post zum Artikel', description: null, channel: 'Social Media (Mastodon/Bluesky)' }).map(a => a.platform)).toEqual(['bluesky', 'mastodon'])
  })

  it('Beschreibung zählt, wenn Kanal und Titel nichts nennen; verneinte Plattformen nicht', () => {
    const t = { ...t021, title: 'Post: Frage an KI-Musiker', description: 'Auf Mastodon und Bluesky posten, nicht auf X.' }
    expect(taskListedPlatforms(t)).toEqual(['bluesky', 'mastodon'])
    expect(namedPlatforms('Mastodon + X')).toEqual(['mastodon', 'x'])
    expect(namedPlatforms('X-Fassung prüfen')).toEqual([])
  })

  it('Orte des Strategie-Kanals zählen mit, Titel mit Plattformliste hat Vorrang', () => {
    const t = { ...t021, title: 'Social-Post zum Artikel', description: null, channel: 'Social Media (Mastodon/Bluesky)', channelPlaces: ['X (@tonebaseNFT, wird umbenannt)', 'r/SunoAI'] }
    expect(taskListedPlatforms(t)).toEqual(['bluesky', 'mastodon', 'x'])
    expect(targetAccounts(target, t).map(a => a.platform)).toEqual(['x', 'bluesky', 'mastodon'])
    expect(postPlatforms(t, ['x', 'bluesky', 'mastodon'])).toEqual(['bluesky', 'mastodon', 'x'])
    expect(taskListedPlatforms({ ...t, title: 'Frage an KI-Musiker (Mastodon + Bluesky)' })).toEqual(['bluesky', 'mastodon'])
    expect(taskListedPlatforms({ ...t, channelPlaces: ['Hypebot'] })).toEqual(['bluesky', 'mastodon'])
    expect(taskListedPlatforms({ ...t, channel: 'Social Media (Mastodon)', channelPlaces: ['X'] })).toEqual(['mastodon', 'x'])
  })

  it('eine einzelne Plattform im Titel: nur diese', () => {
    expect(targetAccounts(target, { ...t021, title: 'Post auf Mastodon', description: null }).map(a => a.platform)).toEqual(['mastodon'])
  })
})

describe('freier Termin', () => {
  it('3 Stunden Abstand, sonst später, sonst früher, sonst nächster Tag', () => {
    expect(freeSlot('2026-10-18', '11:00', [{ date: '2026-10-18', time: '11:00' }])).toEqual({ date: '2026-10-18', time: '14:00' })
    expect(freeSlot('2026-10-18', '11:00', [{ date: '2026-10-18', time: '11:00' }, { date: '2026-10-18', time: '13:00' }])).toEqual({ date: '2026-10-18', time: '16:00' })
    expect(freeSlot('2026-10-18', '20:00', [{ date: '2026-10-18', time: '19:00' }])).toEqual({ date: '2026-10-18', time: '16:00' })
    const full = ['07:00', '10:00', '13:00', '16:00', '19:00'].map(time => ({ date: '2026-10-16', time }))
    expect(freeSlot('2026-10-16', '10:00', full, { weekend: false })).toEqual({ date: '2026-10-19', time: '10:00' })
    expect(freeSlot('2026-10-16', '10:00', full)).toEqual({ date: '2026-10-17', time: '10:00' })
    expect(freeSlot('2026-10-17', '09:00', [], { today: '2026-10-17', now: '12:00' })).toEqual({ date: '2026-10-17', time: '12:15' })
  })

  it('Plattformen unbekannt: gilt als überall', () => {
    expect(postPlatforms({ title: 'Post', category: 'social', channel: null, targetUrl: null, description: null }, [])).toEqual(['*'])
  })
})

describe('Social-Posts eines Projekts nie zur selben Zeit', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let pid: string
  let peter: string
  const day = '2026-12-18'
  const base = () => ({ workspaceId: ws.id, projectId: pid, category: 'social' as const, dueDate: day, draftKind: 'post' as const })
  const timeOf = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!

  beforeAll(async () => {
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
    peter = (await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning())[0]!.id
    pid = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'bit', name: 'tonebase', code: 'BIT', icon: 'B' }).returning())[0]!.id
  })
  afterAll(async () => {
    await close()
  })

  it('automatisch geplanter Post weicht auf den nächsten freien Termin', async () => {
    const a = await createTask(db, { ...base(), title: 'Post: Frage (Mastodon + Bluesky)', dueTime: '11:00' })
    const b = await createTask(db, { ...base(), title: 'Social-Post zum Artikel', channel: 'Social Media (Mastodon/Bluesky)', dueTime: '11:00', origin: 'rss' })
    expect(a.dueTime).toBe('11:00')
    expect(b.dueTime).toBe('14:00')
    const c = await createTask(db, { ...base(), title: 'Post auf Instagram', channel: 'Instagram', dueTime: '11:00' })
    expect(c.dueTime).toBe('11:00')
  })

  it('vom Menschen gesetzte Uhrzeit bleibt, die automatische weicht', async () => {
    const auto = await createTask(db, { ...base(), dueDate: '2026-12-21', title: 'Post zum Artikel', channel: 'Mastodon', dueTime: '10:00' })
    const mine = await createTask(db, { ...base(), dueDate: '2026-12-21', title: 'Mein Post', channel: 'Mastodon', dueTime: '10:00', createdByUserId: peter })
    expect(mine.dueTime).toBe('10:00')
    expect((await timeOf(auto.id)).dueTime).toBe('13:00')
    const moved = await updateTask(db, await timeOf(mine.id), { dueTime: '13:00' }, { type: 'user', userId: peter })
    expect(moved.dueTime).toBe('13:00')
    expect((await timeOf(auto.id)).dueTime).toBe('16:00')
    const sys = await updateTask(db, await timeOf(auto.id), { dueTime: '13:30' }, { type: 'system' })
    expect(sys.dueTime).toBe('16:00')
  })

  it('Tageshöchstzahl zählt die Plattformen der Entwürfe, nicht nur den Kanal der Aufgabe', async () => {
    await db.update(schema.projects).set({ setup: { pacing: { perPlatformPerDay: 1 } } }).where(eq(schema.projects.id, pid))
    const d = '2026-12-26'
    const a = await createTask(db, { ...base(), dueDate: d, title: 'Serie 1/3: Track', channel: 'Instagram', dueTime: '09:00' })
    await db.insert(schema.drafts).values({ taskId: a.id, kind: 'post', body: 'x', platforms: ['x', 'instagram'] })
    const b = await createTask(db, { ...base(), dueDate: d, title: 'Post auf X', channel: 'X', dueTime: '18:00' })
    expect(b.dueDate).toBe('2026-12-27')
    const c = await createTask(db, { ...base(), dueDate: d, title: 'Post auf Mastodon', channel: 'Mastodon', dueTime: '18:00' })
    expect(c.dueDate).toBe(d)
    await db.insert(schema.drafts).values({ taskId: c.id, kind: 'post', body: 'x', platforms: ['mastodon', 'instagram'] })
    const again = await updateTask(db, await timeOf(c.id), { dueTime: '19:00' }, { type: 'system' })
    expect(again.dueDate).toBe('2026-12-27')
    expect(freeSlot(d, '10:00', [{ date: d, time: '18:00', platforms: ['x'] }], { maxPerDay: 1, platforms: ['bluesky'] })).toEqual({ date: d, time: '10:00' })
    expect(freeSlot(d, '10:00', [{ date: d, time: '18:00', platforms: ['x'] }], { maxPerDay: 1, platforms: ['x', 'bluesky'] }).date).toBe('2026-12-27')
  })
})

describe('Strategie-Kanal: Orte und Umbenennen', () => {
  let db: Db
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ db, close } = await openTestDb())
  })
  afterAll(async () => {
    await close()
  })

  it('update_channel benennt um, Schlüssel und Zuordnung bleiben, Orte zählen für die Plattformwahl', async () => {
    const ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
    const owner = (await db.insert(schema.users).values({ email: 'owner@test.local', name: 'Peter' }).returning())[0]!.id
    const pid = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'B' }).returning())[0]!.id
    const key = 'social-media-mastodon-bluesky'
    const old = 'Social Media (Mastodon/Bluesky)'
    await db.insert(schema.strategies).values({ workspaceId: ws.id, projectId: pid, status: 'aktiv', channels: [{ key, name: old, category: 'social', why: 'Reichweite', goalIds: [], weight: 2, base: 0, days: ['di'], time: '11:00', active: true, places: [], topics: [] }] })
    const open = await createTask(db, { workspaceId: ws.id, projectId: pid, category: 'social', title: 'Social-Post zum Artikel', channel: old, strategyChannel: key, dueDate: '2026-12-20', draftKind: 'post' })
    const actor: ChatActor = { workspace: ws, userId: owner, userName: 'Peter', role: 'owner', access: { all: true, ids: [] } }
    const r = await runToolDirect(db, actor, 'update_channel', { project: 'tonebase', channel: key, name: 'Social Media (Mastodon/Bluesky/X)', places: ['X (@tonebaseNFT, wird umbenannt)'] }) as { channel: string, key: string }
    expect(r.channel).toBe('Social Media (Mastodon/Bluesky/X)')
    expect(r.key).toBe(key)
    const task = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, open.id)))[0]!
    expect(task.strategyChannel).toBe(key)
    expect(task.channel).toBe('Social Media (Mastodon/Bluesky/X)')
    const [placed] = await withChannelPlaces(db, [task])
    expect(placed!.channelPlaces).toEqual(['X (@tonebaseNFT, wird umbenannt)'])
    expect(taskListedPlatforms({ ...placed!, channel: old })).toEqual(['bluesky', 'mastodon', 'x'])
  })
})
