import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sealAppSecret, updateSettings } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { resetSecretCache } from '../../server/lib/secret'
import { bingDay, pickBingSite, publicBing, setBingSite, syncProjectBing } from '../../server/lib/bing-webmaster'
import { searchSummary, seoDigest, syncAllSearch } from '../../server/lib/search-console'
import { dailyValues } from '../../server/lib/goals'
import { searchTerms } from '../../server/lib/api/service'

const KEY = 'bingkey0123456789abcdef0123456789'
const APP = 'http://localhost:3210'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect

async function reload() {
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
}

const ms = (d: string) => `/Date(${Date.parse(`${d}T07:00:00Z`)}-0700)/`

function bingApi(calls: string[]) {
  return async (url: string) => {
    calls.push(url)
    const u = new URL(url)
    expect(u.origin + u.pathname.replace(/\/[^/]+$/, '')).toBe('https://ssl.bing.com/webmaster/api.svc/json')
    if (u.searchParams.get('apikey') !== KEY) return Response.json({ ErrorCode: 3, Message: 'InvalidApiKey' }, { status: 401 })
    const method = u.pathname.split('/').pop()
    if (method === 'GetUserSites') return Response.json({ d: [{ __type: 'Site:#Microsoft.Bing.Webmaster.Api', Url: 'https://tonebase.com/', IsVerified: true }, { Url: 'https://chatsite.site/', IsVerified: true }, { Url: 'https://other.example/', IsVerified: false }] })
    expect(u.searchParams.get('siteUrl')).toBe('https://chatsite.site/')
    if (method === 'GetRankAndTrafficStats') return Response.json({ d: [{ Date: ms('2026-10-01'), Clicks: 2, Impressions: 60 }, { Date: ms('2026-10-02'), Clicks: 1, Impressions: 40 }, { Date: ms('2026-05-01'), Clicks: 9, Impressions: 900 }] })
    if (method === 'GetPageStats') return Response.json({ d: [{ Date: ms('2026-09-27'), Query: 'https://chatsite.site/features', Clicks: 3, Impressions: 100, AvgImpressionPosition: 5, AvgClickPosition: 4 }] })
    if (method === 'GetQueryStats') return Response.json({ d: [{ Date: ms('2026-09-27'), Query: 'website chatbot', Clicks: 3, Impressions: 20, AvgImpressionPosition: 2 }, { Date: ms('2026-09-27'), Query: 'bing only term', Clicks: 0, Impressions: 80, AvgImpressionPosition: 6 }] })
    return new Response('?', { status: 404 })
  }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-09T09:00:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'chatsite', name: 'chatsite', code: 'AMW', icon: 'A', url: 'https://www.chatsite.site/de' }).returning())[0]!
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Bing Webmaster Tools', () => {
  it('liest Bing-Datumsangaben und ordnet die Website zu', () => {
    expect(bingDay('/Date(1759302000000-0700)/')).toBe('2025-10-01')
    expect(bingDay('/Date(1759276800000)/')).toBe('2025-10-01')
    expect(bingDay('2026-10-01T00:00:00')).toBe('2026-10-01')
    expect(bingDay('kaputt')).toBeNull()
    expect(pickBingSite(['https://tonebase.com/', 'http://chatsite.site/', 'https://chatsite.site/'], 'chatsite.site')).toBe('https://chatsite.site/')
    expect(pickBingSite(['https://tonebase.com/'], 'https://chatsite.site')).toBeNull()
  })

  it('ohne Schlüssel passiert nichts, mit Schlüssel holt der Abruf Google-unabhängig die Bing-Zahlen', async () => {
    expect((await syncAllSearch(db, ws, APP)).projects).toBe(0)
    await updateSettings(db, ws.id, s => ({ ...s, apps: { ...s.apps, bing: { clientId: '', secret: sealAppSecret(ws.id, 'bing', KEY) } } }))
    await reload()
    expect(JSON.stringify(ws.settings)).not.toContain(KEY)
    const calls: string[] = []
    const r = await syncAllSearch(db, ws, APP, { fetchImpl: bingApi(calls) as typeof fetch })
    expect(r).toMatchObject({ projects: 1, rows: 5, errors: [], sources: ['bing'] })
    expect(calls.map(c => new URL(c).pathname.split('/').pop())).toEqual(['GetUserSites', 'GetRankAndTrafficStats', 'GetPageStats', 'GetQueryStats'])
    await reload()
    expect(publicBing(ws, project.setup.bing)).toMatchObject({ keyReady: true, site: 'https://chatsite.site/', off: false, error: null })
    expect(project.setup.bing?.lastSync).toBeTruthy()
    const rows = await db.select().from(schema.searchStats)
    expect(rows.every(x => x.source === 'bing')).toBe(true)
    expect(rows.some(x => x.day === '2026-05-01')).toBe(false)
    calls.length = 0
    expect(await syncProjectBing(db, ws, project, bingApi(calls) as typeof fetch)).toBe(5)
    expect(calls.some(c => c.includes('GetUserSites'))).toBe(false)
    expect(await db.select().from(schema.searchStats)).toHaveLength(5)
  })

  it('Google und Bing zusammen: Summe ohne Doppelzählung, je Quelle getrennt', async () => {
    await db.insert(schema.searchStats).values([
      { projectId: project.id, source: 'google', day: '2026-10-01', query: '', page: '', clicks: 5, impressions: 400, position: 8 },
      { projectId: project.id, source: 'google', day: '2026-10-01', query: 'website chatbot', page: 'https://chatsite.site/', clicks: 4, impressions: 30, position: 3 },
    ])
    const all = await searchSummary(db, project.id, '2026-09-11', '2026-10-08')
    expect(all.clicks).toBe(8)
    expect(all.impressions).toBe(500)
    expect(all.bySource).toEqual([{ source: 'google', clicks: 5, impressions: 400 }, { source: 'bing', clicks: 3, impressions: 100 }])
    expect(all.position).toBe(7.4)
    expect(all.top[0]).toMatchObject({ query: 'website chatbot', clicks: 7, impressions: 50, page: 'https://chatsite.site/' })
    expect(all.chances.map(c => c.query)).toEqual(['bing only term'])
    const bing = await searchSummary(db, project.id, '2026-09-11', '2026-10-08', { source: 'bing' })
    expect(bing).toMatchObject({ clicks: 3, impressions: 100, position: 5 })
    expect((await searchSummary(db, project.id, '2026-09-11', '2026-10-08', { source: 'google' })).clicks).toBe(5)
    const days = await dailyValues(db, project.id, 'visitors', '2026-09-11', '2026-10-08')
    expect(days.get('2026-10-01')).toBe(7)
    expect(days.get('2026-10-02')).toBe(1)
    expect([...days.values()].reduce((a, b) => a + b, 0)).toBe(8)
  })

  it('Agent und MCP sehen die Bing-Zahlen mit', async () => {
    const text = await seoDigest(db, project, '2026-10-09')
    expect(text).toContain('Google- und Bing-Suche (Search Console und Bing Webmaster Tools')
    expect(text).toContain('Bing 3 Klicks')
    expect(text).toContain('"bing only term"')
    expect(await seoDigest(db, project, '2026-10-09', { short: true })).toContain('Google- und Bing-Suche: Leute finden die Seite über "website chatbot"')
    const [u] = await db.insert(schema.users).values({ email: 'p@x.example', name: 'Peter' }).returning()
    await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: u!.id, role: 'owner' })
    const out = await searchTerms(db, { workspace: ws, userId: u!.id, userName: 'Peter', role: 'owner', access: { all: true, ids: [] } }, 'chatsite', { from: '2026-09-11', to: '2026-10-08' })
    expect(out.connected).toBe(true)
    expect(out.bing).toMatchObject({ connected: true, site: 'https://chatsite.site/' })
    expect(out.clicks).toBe(8)
    expect(out.bySource.map(x => x.source)).toEqual(['google', 'bing'])
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  it('abgelehnter Schlüssel wird verständlich gemeldet und nie ausgegeben', async () => {
    await updateSettings(db, ws.id, s => ({ ...s, apps: { ...s.apps, bing: { clientId: '', secret: sealAppSecret(ws.id, 'bing', 'falscherschluessel123456') } } }))
    await reload()
    const err = await syncProjectBing(db, ws, project, bingApi([]) as typeof fetch).catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Bing-API-Schlüssel abgelehnt/)
    expect((err as Error).message).not.toContain('falscherschluessel')
    await reload()
    expect(project.setup.bing?.error).toMatch(/Plattform-Zugänge/)
  })

  it('Ausschalten löscht nur die Bing-Zahlen und der Abruf lässt das Projekt aus', async () => {
    await setBingSite(db, project.id, null)
    await reload()
    const rows = await db.select().from(schema.searchStats)
    expect(rows.length).toBe(2)
    expect(rows.every(x => x.source === 'google')).toBe(true)
    expect(project.setup.bing).toMatchObject({ off: true, site: null })
    expect((await syncAllSearch(db, ws, APP, { fetchImpl: bingApi([]) as typeof fetch })).projects).toBe(0)
  })
})
