import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { goalCurrent } from '../../server/lib/goals'

let db: Db
let close: () => Promise<void>

beforeAll(async () => {
  ;({ db, close } = await openTestDb())
})
afterAll(async () => {
  await close()
})

describe('Ziele aus UTM und Search Console', () => {
  it('Besucher = UTM-Besuche + Google-Klicks, Anmeldungen aus UTM, eingetragene Zahl hat Vorrang', async () => {
    const [ws] = await db.insert(schema.workspaces).values({ name: 'T' }).returning()
    const [p] = await db.insert(schema.projects).values({ workspaceId: ws!.id, slug: 'amw', name: 'chatsite', code: 'AMW', icon: 'A' }).returning()
    const goal = (key: string) => db.insert(schema.goals).values({ workspaceId: ws!.id, projectId: p!.id, label: key, metricKey: key, mode: 'month' }).returning().then(r => r[0]!)
    await db.insert(schema.utmStats).values([
      { projectId: p!.id, day: '2026-10-05', source: 'bluesky', medium: 'social', campaign: 'amw-soc-001', visits: 3, signups: 1 },
      { projectId: p!.id, day: '2026-09-10', source: 'bluesky', medium: 'social', campaign: 'amw-soc-000', visits: 7 },
    ])
    await db.insert(schema.searchStats).values([
      { projectId: p!.id, day: '2026-10-06', query: '', page: '', clicks: 4, impressions: 100 },
      { projectId: p!.id, day: '2026-10-06', query: 'chatbase alternative', page: '', clicks: 4, impressions: 50 },
    ])
    const visitors = await goal('visitors')
    expect(await goalCurrent(db, visitors, '2026-10-13')).toBe(7)
    expect(await goalCurrent(db, await goal('trials'), '2026-10-13')).toBe(1)
    expect(await goalCurrent(db, await goal('customers'), '2026-10-13')).toBe(0)
    await db.insert(schema.metrics).values({ projectId: p!.id, key: 'visitors', day: '2026-10-10', value: 120, source: 'chat' })
    expect(await goalCurrent(db, visitors, '2026-10-13')).toBe(120)
  })
})
