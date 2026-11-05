import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { buildWeeklyReport, renderReportHtml } from '../../server/services/report'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
const P: Record<string, typeof schema.projects.$inferSelect> = {}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Agentur', settings: { agentEnabled: false } }).returning())[0]!
  P.thewanderer = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'thewanderer', code: 'TV', icon: 'T', url: 'https://thewanderer.example', rules: 'Geheime Regel: nie X erwähnen', languages: ['en'] }).returning())[0]!
})

afterAll(async () => {
  delete process.env.MA_NOW
  await close()
})

describe('Wochenbericht als Druckseite', () => {
  it('liefert alle Abschnitte mit Zeitraum, Veröffentlichtem, Kennzahlen, Zielen und Plan', async () => {
    const p = P.thewanderer!
    const [done] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p.id, code: 'TV-SOC-900', title: 'Album ist da', category: 'social', status: 'erledigt', doneAt: new Date('2026-10-10T09:00:00Z') }).returning()
    await db.insert(schema.taskLinks).values({ workspaceId: ws.id, projectId: p.id, taskId: done!.id, platform: 'bluesky', url: 'https://bsky.app/profile/tv/post/1', postedAt: new Date('2026-10-10T09:00:00Z') })
    await db.insert(schema.results).values({ taskId: done!.id, metric: 'likes', value: 42, source: 'social', measuredOn: '2026-10-11' })
    await db.insert(schema.geoChecks).values({ workspaceId: ws.id, projectId: p.id, week: '2026-10-12', summary: { asked: 6, mentioned: 2, models: ['m'], competitors: [], webAsked: 0, webHits: 0 } as never })
    await db.insert(schema.goals).values({ workspaceId: ws.id, projectId: p.id, label: '100 Follower', metricKey: 'followers', mode: 'last', targetValue: 100, active: true })
    await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p.id, code: 'TV-SOC-901', title: 'Tourdaten posten', category: 'social', dueDate: '2026-10-15', dueTime: '11:00', channel: 'Bluesky' })
    const r = await buildWeeklyReport(db, ws, p)
    expect(r).toMatchObject({ from: '2026-10-06', to: '2026-10-12' })
    const html = renderReportHtml(r, 'de')
    for (const k of ['period', 'published', 'metrics', 'goals', 'next']) expect(html).toContain(`data-k="${k}"`)
    expect(html).toContain('href="https://bsky.app/profile/tv/post/1"')
    expect(html).toContain('Likes')
    expect(html).toContain('In 2 von 6 KI-Antworten genannt')
    expect(html).toContain('100 Follower')
    expect(html).toContain('Tourdaten posten')
    expect(html).toContain('@media print')
    await db.insert(schema.taskNotes).values({ taskId: done!.id, byAgent: true, text: 'Interne Notiz' })
    expect(renderReportHtml(await buildWeeklyReport(db, ws, p), 'de')).not.toMatch(/Geheime Regel|Interne Notiz|EUR/)
    expect(html).not.toMatch(/Geheime Regel|EUR/)
    expect(renderReportHtml(r, 'en')).toContain('Weekly report')
  })

})
