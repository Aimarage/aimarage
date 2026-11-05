import { and, eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyBestTimes, bestTimes, computeTimes, engagement, proposeEvergreen, suggestSlot, type PostSample } from '../../server/lib/best-times'
import { openTestDb, schema, type Db } from '../../server/lib/db'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect

const TZ = 'Europe/Vienna'
const at = (iso: string) => new Date(iso)

function samples(): PostSample[] {
  const out: PostSample[] = []
  for (let i = 0; i < 4; i++) out.push({ platform: 'bluesky', postedAt: at(`2026-09-${String(1 + i * 7).padStart(2, '0')}T08:00:00Z`), score: 40 })
  for (let i = 0; i < 4; i++) out.push({ platform: 'bluesky', postedAt: at(`2026-09-${String(3 + i * 7).padStart(2, '0')}T15:00:00Z`), score: 5 })
  for (let i = 0; i < 3; i++) out.push({ platform: 'bluesky', postedAt: at(`2026-09-${String(5 + i * 7).padStart(2, '0')}T18:30:00Z`), score: 2 })
  return out
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-12T05:00:00+02:00'
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', timezone: TZ }).returning())[0]!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'B', url: 'https://tonebase.com' }).returning())[0]!
  await db.insert(schema.strategies).values({ workspaceId: ws.id, projectId: project.id, status: 'aktiv', channels: [
    { key: 'social', name: 'Social Media', category: 'social', why: '', goalIds: [], weight: 5, days: ['MO', 'WE', 'FR'], time: '11:00', active: true },
    { key: 'blog', name: 'Blog', category: 'content', why: '', goalIds: [], weight: 3, days: ['MO'], time: '10:00', active: true },
  ] })
})
afterAll(async () => {
  delete process.env.MA_NOW
  await close()
})

describe('Beste Zeiten berechnen', () => {
  it('ab 10 Beiträgen aus Zahlen: bester Tag zuerst, Uhrzeit des besten Fensters', () => {
    const r = computeTimes('bluesky', samples(), TZ)
    expect(r.source).toBe('data')
    expect(r.posts).toBe(11)
    expect(r.days).toContain(2)
    expect(r.days).toHaveLength(3)
    expect(r.time).toBe('10:00')
  })

  it('unter 10 Beiträgen Standardzeiten der Plattform', () => {
    expect(computeTimes('linkedin', samples().slice(0, 9).map(s => ({ ...s, platform: 'linkedin' })), TZ)).toEqual({ platform: 'linkedin', posts: 9, source: 'default', days: [2, 3, 4], time: '08:30' })
    expect(computeTimes('unbekannt', [], TZ).time).toBe('10:00')
    expect(engagement({ likes: 3, comments: 1, shares: 1, clicks: 0, reach: 100 })).toBe(9)
  })

  it('Vorschlag: heute, wenn die Uhrzeit noch kommt, sonst nächster passender Tag', () => {
    const data = { platform: 'bluesky', posts: 12, source: 'data' as const, days: [2, 4], time: '10:00' }
    expect(suggestSlot(data, '2026-10-12', '09:00', '2026-10-12', 'soon')).toEqual({ date: '2026-10-12', time: '10:00' })
    expect(suggestSlot(data, '2026-10-12', '11:00', '2026-10-12', 'soon')).toEqual({ date: '2026-10-13', time: '10:00' })
    expect(suggestSlot(data, '2026-10-12', '09:00', '2026-10-12', 'best')).toEqual({ date: '2026-10-13', time: '10:00' })
    const def = { ...data, source: 'default' as const }
    expect(suggestSlot(def, '2026-10-12', '09:00', '2026-10-12', 'soon', '11:30').time).toBe('11:30')
    expect(suggestSlot(null, '2026-10-12', '09:00', '2026-10-12', 'soon')).toEqual({ date: '2026-10-12', time: null })
  })
})

describe('Planer und Evergreen', () => {
  async function post(code: string, postedAt: string, likes: number, body = `Text ${code}`) {
    const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code, title: `Post ${code}`, category: 'social', status: 'erledigt', channel: 'Social Media', targetUrl: 'https://tonebase.com/blog/x' }).returning()
    await db.insert(schema.taskLinks).values({ workspaceId: ws.id, projectId: project.id, taskId: t!.id, platform: 'bluesky', url: `https://bsky.app/${code}`, postedAt: at(postedAt) })
    await db.insert(schema.results).values({ taskId: t!.id, metric: 'likes', value: likes, source: 'social', measuredOn: postedAt.slice(0, 10) })
    await db.insert(schema.drafts).values({ taskId: t!.id, body, status: 'freigegeben', byAgent: true })
    return t!
  }

  it('Wochen-Review übernimmt beste Zeiten aus Daten in den Social-Kanal', async () => {
    const s = samples()
    for (const [i, x] of s.entries()) await post(`BIT-SOC-${100 + i}`, x.postedAt.toISOString(), x.score)
    const list = await bestTimes(db, ws, project)
    expect(list[0]).toMatchObject({ platform: 'bluesky', source: 'data', time: '10:00' })
    const changed = await applyBestTimes(db, ws, project)
    expect(changed).toHaveLength(1)
    const [st] = await db.select().from(schema.strategies).where(eq(schema.strategies.projectId, project.id))
    const social = st!.channels.find(c => c.key === 'social')!
    expect(social.time).toBe('10:00')
    expect(social.days).toHaveLength(3)
    expect(social.days).toContain('TU')
    expect(st!.channels.find(c => c.key === 'blog')!.time).toBe('10:00')
    expect(await applyBestTimes(db, ws, project)).toEqual([])
  })

  it('Evergreen: bester alter Beitrag als neue Aufgabe mit Originaltext, höchstens 1 pro Woche', async () => {
    await post('BIT-SOC-900', '2026-08-01T08:00:00Z', 200, 'Der beste Beitrag')
    await post('BIT-SOC-901', '2026-10-05T08:00:00Z', 500, 'Zu jung')
    const r = await proposeEvergreen(db, ws, project)
    expect(r?.title).toBe('Neu aufgelegt: Post BIT-SOC-900')
    const [t] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, project.id), like(schema.tasks.origin, 'evergreen:%')))
    expect(t).toMatchObject({ category: 'social', draftKind: 'post', targetUrl: 'https://tonebase.com/blog/x', dueTime: '10:00' })
    expect(t!.description).toContain('Der beste Beitrag')
    expect(t!.description).toContain('nicht 1:1')
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))
    expect(job!.payload).toMatchObject({ taskId: t!.id, hold: true })
    expect(await proposeEvergreen(db, ws, project)).toBeNull()
  })

  it('ohne deutlich überdurchschnittlichen Beitrag kein Vorschlag', async () => {
    const [p2] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'flat', name: 'flat', code: 'FLT', icon: 'F' }).returning()
    for (let i = 0; i < 6; i++) {
      const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p2!.id, code: `FLT-SOC-${i}`, title: 't', category: 'social', status: 'erledigt' }).returning()
      await db.insert(schema.taskLinks).values({ workspaceId: ws.id, projectId: p2!.id, taskId: t!.id, platform: 'bluesky', url: `https://bsky.app/f${i}`, postedAt: at('2026-07-01T08:00:00Z') })
      await db.insert(schema.results).values({ taskId: t!.id, metric: 'likes', value: 10, source: 'social', measuredOn: '2026-07-02' })
      await db.insert(schema.drafts).values({ taskId: t!.id, body: 'x', status: 'freigegeben' })
    }
    expect(await proposeEvergreen(db, ws, p2!, { draft: false })).toBeNull()
  })
})
