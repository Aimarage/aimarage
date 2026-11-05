import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runUtmSync } from '../../server/lib/agent'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { reviewPrompt } from '../../server/prompts/de'
import { resetSecretCache } from '../../server/lib/secret'
import { buildStats, checkStats, copyStatsToken, fetchUtm, normalizePrefix, publicStats, statsToken, syncProjectUtm, trafficDigest, TrafficError, utmSummary } from '../../server/lib/traffic'

const URL_A = 'https://tonebase.example/api/v1/admin/utm'
const TOKEN = 'bss_lesetoken_1234567890'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect

interface Call { url: string, init: RequestInit }

function fakeFetch(rows: Record<string, unknown>[], status = 200) {
  const calls: Call[] = []
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ from: '', to: '', currency: 'EUR', timezone: 'Europe/Vienna', rows, totals: {} }), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { f, calls }
}

const row = (day: string, source: string, campaign: string, n: Partial<Record<'visits' | 'signups' | 'interests' | 'purchases' | 'netCents', number>> = {}) => ({ day, source, medium: 'social', campaign, content: '', visits: 0, signups: 0, interests: 0, purchases: 0, netCents: 0, ...n })

async function reload() {
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-08T09:00:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'B' }).returning())[0]!
  await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'BIT-SOC-012', title: 'Bluesky-Post zum Release', category: 'social', status: 'erledigt', strategyChannel: 'bluesky' })
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Statistik-Zugang', () => {
  it('Token verschlüsselt, an Adresse gebunden, neue Adresse verwirft ihn', () => {
    const s = buildStats(ws.id, project.id, null, { url: `${URL_A}?x=1`, token: TOKEN })
    expect(s.url).toBe(URL_A)
    expect(JSON.stringify(s)).not.toContain(TOKEN)
    expect(statsToken(ws.id, project.id, s)).toBe(TOKEN)
    expect(statsToken(ws.id, project.id, { ...s, url: 'https://evil.example/utm' })).toBeNull()
    expect(JSON.stringify(publicStats(s))).not.toContain(TOKEN)
    const kept = buildStats(ws.id, project.id, s, { url: URL_A })
    expect(kept.secret).toEqual(s.secret)
    const moved = buildStats(ws.id, project.id, { ...s, lastSync: '2026-10-07T07:00:00Z' }, { url: 'https://other.example/utm' })
    expect(moved.secret).toBeNull()
    expect(moved.lastSync).toBeNull()
  })

  it('Abruf: Bearer-Token, Zeitraum, kein Origin, keine Weiterleitung', async () => {
    const { f, calls } = fakeFetch([row('2026-10-07', 'Bluesky', 'BIT-SOC-012', { visits: 3 }), row('2025-01-01', 'x', ''), { day: 'kaputt' }])
    const r = await fetchUtm(URL_A, TOKEN, { from: '2026-10-07', to: '2026-10-08' }, f)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ source: 'bluesky', campaign: 'bit-soc-012', visits: 3 })
    const u = new URL(calls[0]!.url)
    expect(u.origin + u.pathname).toBe(URL_A)
    expect(u.searchParams.get('from')).toBe('2026-10-07')
    expect(u.searchParams.get('to')).toBe('2026-10-08')
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(Object.keys(h).map(k => k.toLowerCase())).not.toContain('origin')
    expect(Object.keys(h).map(k => k.toLowerCase())).not.toContain('sec-fetch-site')
    expect(calls[0]!.init.redirect).toBe('error')
  })

  it('Fehler verständlich und ohne Token', async () => {
    const { f } = fakeFetch([], 401)
    const err = await fetchUtm(URL_A, TOKEN, { from: '2026-10-07', to: '2026-10-08' }, f).catch(e => e)
    expect(err).toBeInstanceOf(TrafficError)
    expect(err.message).toMatch(/Token abgelehnt/)
    const boom = async () => {
      throw new Error(`connect failed for ${TOKEN}`)
    }
    const err2 = await fetchUtm(URL_A, TOKEN, { from: '2026-10-07', to: '2026-10-08' }, boom).catch(e => e)
    expect(err2.message).not.toContain(TOKEN)
  })
})

describe('Abholen und speichern', () => {
  it('Prüfen zählt Zeilen der letzten 30 Tage, speichert nichts', async () => {
    const stats = buildStats(ws.id, project.id, null, { url: URL_A, token: TOKEN })
    await db.update(schema.projects).set({ setup: { ...project.setup, stats } }).where(eq(schema.projects.id, project.id))
    await reload()
    const { f, calls } = fakeFetch([row('2026-10-01', 'bluesky', 'bit-soc-012', { visits: 5 }), row('2026-10-02', 'mastodon', '', { visits: 2 })])
    const r = await checkStats(db, ws, project, f)
    expect(r).toEqual({ ok: true, rows: 2, days: 30, error: null })
    expect(new URL(calls[0]!.url).searchParams.get('from')).toBe('2026-09-09')
    expect(await db.select().from(schema.utmStats)).toHaveLength(0)
  })

  it('erstmalig 30 Tage, danach 2 Tage, Zeitraum wird ersetzt', async () => {
    await reload()
    const first = fakeFetch([
      row('2026-09-20', 'bluesky', 'bit-soc-012', { visits: 40, signups: 3, purchases: 2, netCents: 1660 }),
      row('2026-10-07', 'bluesky', 'bit-soc-012', { visits: 2 }),
      row('2026-10-07', 'mastodon', 'bit-soc-099', { visits: 7, signups: 1 }),
      row('2026-10-07', '', '', { visits: 4 }),
    ])
    expect(await syncProjectUtm(db, ws, project, first.f)).toBe(4)
    expect(new URL(first.calls[0]!.url).searchParams.get('from')).toBe('2026-09-09')
    await reload()
    expect(project.setup.stats?.lastSync).toBeTruthy()

    const second = fakeFetch([row('2026-10-07', 'bluesky', 'bit-soc-012', { visits: 6, signups: 1 })])
    await syncProjectUtm(db, ws, project, second.f)
    expect(new URL(second.calls[0]!.url).searchParams.get('from')).toBe('2026-10-07')
    const all = await db.select().from(schema.utmStats).where(eq(schema.utmStats.projectId, project.id))
    expect(all.map(r => `${r.day} ${r.source} ${r.visits}`).sort()).toEqual(['2026-09-20 bluesky 40', '2026-10-07 bluesky 6'])
  })

  it('Job protokolliert Fehler und stürzt nicht ab', async () => {
    const { f } = fakeFetch([], 500)
    const out = await runUtmSync(db, ws, null, f as typeof fetch)
    expect(out.status).toBe('ok')
    expect(out.summary).toMatch(/Fehler: tonebase: Seite antwortet mit Fehler 500/)
    await reload()
    expect(project.setup.stats?.error).toMatch(/500/)
    expect(await db.select().from(schema.utmStats).where(eq(schema.utmStats.projectId, project.id))).toHaveLength(2)
  })

  it('ohne Zugang übersprungen', async () => {
    const other = (await db.insert(schema.workspaces).values({ name: 'Leer' }).returning())[0]!
    expect((await runUtmSync(db, other)).status).toBe('skipped')
  })
})

describe('Anteil eines anderen Projekts auf derselben Seite', () => {
  it('Zugang verschlüsselt übernehmen, nur Kampagnen mit Anfang the-', async () => {
    await reload()
    const band = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'The Wanderer', code: 'THE', icon: 'V' }).returning())[0]!
    expect(normalizePrefix(' The_Wanderer ')).toBe('the-wanderer')
    expect(normalizePrefix('  ')).toBeNull()
    const base = buildStats(ws.id, band.id, null, { url: URL_A, campaignPrefix: 'THE-' })
    expect(base.campaignPrefix).toBe('the-')
    expect(base.secret).toBeNull()
    const s = copyStatsToken(ws.id, { id: project.id, stats: project.setup.stats }, { id: band.id, stats: base })
    expect(s.secret!.enc).not.toBe(project.setup.stats!.secret!.enc)
    expect(JSON.stringify(s)).not.toContain(TOKEN)
    expect(statsToken(ws.id, band.id, s)).toBe(TOKEN)
    expect(statsToken(ws.id, project.id, { ...s })).toBeNull()
    expect(publicStats(s)!.campaignPrefix).toBe('the-')
    expect(() => copyStatsToken(ws.id, { id: project.id, stats: project.setup.stats }, { id: band.id, stats: { ...base, url: 'https://other.example/utm' } })).toThrow(TrafficError)
    expect(() => copyStatsToken(ws.id, { id: band.id, stats: base }, { id: project.id, stats: base })).toThrow(TrafficError)
    expect(buildStats(ws.id, band.id, { ...s, lastSync: '2026-10-07T07:00:00Z' }, { url: URL_A }).lastSync).toBe('2026-10-07T07:00:00Z')
    expect(buildStats(ws.id, band.id, { ...s, lastSync: '2026-10-07T07:00:00Z' }, { url: URL_A, campaignPrefix: 'x-' }).lastSync).toBeNull()

    await db.update(schema.projects).set({ setup: { stats: s } }).where(eq(schema.projects.id, band.id))
    const [row0] = await db.select().from(schema.projects).where(eq(schema.projects.id, band.id))
    const { f } = fakeFetch([row('2026-10-07', 'bluesky', 'the-soc-001', { visits: 9, purchases: 1 }), row('2026-10-07', 'bluesky', 'bit-soc-012', { visits: 5 }), row('2026-10-07', 'direkt', '', { visits: 3 })])
    expect((await checkStats(db, ws, row0!, f)).rows).toBe(1)
    expect(await syncProjectUtm(db, ws, row0!, f)).toBe(1)
    const stored = await db.select().from(schema.utmStats).where(eq(schema.utmStats.projectId, band.id))
    expect(stored.map(r => `${r.campaign} ${r.visits}`)).toEqual(['the-soc-001 9'])
  })
})

describe('Auswertung', () => {
  it('je Quelle mit Zuordnung Kampagne zu Aufgabe', async () => {
    const s = await utmSummary(db, ws.id, [project.id], '2026-09-01', '2026-10-08')
    expect(s.totals).toMatchObject({ visits: 46, signups: 4, purchases: 2, netCents: 1660 })
    expect(s.sources[0]!.source).toBe('bluesky')
    expect(s.sources[0]!.campaigns[0]!.task).toMatchObject({ code: 'BIT-SOC-012', strategyChannel: 'bluesky' })
  })

  it('kurze Zusammenfassung für den Agenten', async () => {
    const text = await trafficDigest(db, project, '2026-09-10', '2026-10-07')
    expect(text).toContain('- bluesky: 46 Besuche, 4 Anmeldungen, 2 Käufe, 16,60 EUR (stärkste Aufgaben: BIT-SOC-012)')
    expect(text).toContain('Je Strategie-Kanal')
    expect(await trafficDigest(db, project, '2025-01-01', '2025-01-31')).toBe('')
    const prompt = reviewPrompt({ name: 'tonebase', goals: [], channels: [], proposed: [], traffic: text })
    expect(prompt).toContain('bluesky: 46 Besuche')
    expect(reviewPrompt({ name: 'tonebase', goals: [], channels: [], proposed: [] })).not.toContain('UTM')
  })
})
