import { runInNewContext } from 'node:vm'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { buildCounterStats, cleanPath, COUNTER_SCRIPT, CounterError, handleHit, isBot, parseHit, resetCounter } from '../../server/lib/counter'
import { buildStats, publicStats, statsConfigured, utmSummary } from '../../server/lib/traffic'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let site: string

const hit = (body: Record<string, unknown>, over: Partial<{ ip: string, ua: string | null, origin: string | null, referer: string | null }> = {}) =>
  handleHit(db, { body: JSON.stringify({ site, ...body }), ip: '203.0.113.7', ua: UA, origin: 'https://www.tonebase.example', referer: null, ...over })

async function rows() {
  return db.select().from(schema.utmStats).where(eq(schema.utmStats.projectId, project.id))
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 0
  }
  catch (err) {
    if (err instanceof CounterError) return err.status
    throw err
  }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-27T09:00:00+01:00'
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  const stats = buildCounterStats(null)
  site = stats.site!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'B', url: 'https://tonebase.example', setup: { stats } }).returning())[0]!
  await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'BIT-CON-012', title: 'Bluesky-Post', category: 'social', status: 'erledigt', strategyChannel: 'bluesky' })
})
afterAll(async () => {
  delete process.env.MA_NOW
  await close()
})
beforeEach(async () => {
  resetCounter()
  await db.delete(schema.utmStats)
})

describe('Zähler-Einstellung', () => {
  it('öffentliche Kennung bleibt beim erneuten Speichern, Zähler gilt als eingerichtet', () => {
    const a = buildCounterStats(null)
    expect(a.site).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(a.secret).toBeNull()
    expect(buildCounterStats(a).site).toBe(a.site)
    expect(statsConfigured(a)).toBe(true)
    expect(publicStats(a)).toMatchObject({ mode: 'counter', site: a.site, hasToken: false })
    const api = buildStats(ws.id, project.id, a, { url: 'https://tonebase.example/api/utm', token: 'lesetoken-123456' })
    expect(api.mode).toBe('api')
    expect(publicStats(api)!.site).toBeNull()
    expect(buildCounterStats(api).site).toBe(a.site)
  })
})

describe('Endpunkt /z', () => {
  it('zählt je Tag, Quelle, Medium, Kampagne und Pfad', async () => {
    await hit({ source: 'Bluesky', medium: 'social', campaign: 'BIT-CON-012', path: '/preise?x=1#a', ref: 'bsky.app' })
    await hit({ source: 'bluesky', medium: 'social', campaign: 'bit-con-012', path: '/preise' }, { ip: '203.0.113.8' })
    await hit({ source: 'bluesky', medium: 'social', campaign: 'bit-con-012', path: '/' }, { origin: null, referer: 'https://shop.tonebase.example/' })
    const r = await rows()
    expect(r).toHaveLength(2)
    expect(r.find(x => x.path === '/preise')).toMatchObject({ day: '2026-10-27', source: 'bluesky', medium: 'social', campaign: 'bit-con-012', visits: 2 })
    const s = await utmSummary(db, ws.id, [project.id], '2026-10-27', '2026-10-27')
    expect(s.totals.visits).toBe(3)
    expect(s.sources[0]!.campaigns[0]!.task?.strategyChannel).toBe('bluesky')
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id))
    expect(p!.setup.stats!.lastSync).toBeTruthy()
  })

  it('unbekannte oder ungültige Kennung: 404', async () => {
    expect(await status(hit({ site: 'unbekannt1234', source: 'x' }))).toBe(404)
    expect(await status(hit({ site: '../x', source: 'x' }))).toBe(404)
    expect(await rows()).toHaveLength(0)
  })

  it('fremde Herkunft: 403, auch ohne Origin und Referer', async () => {
    expect(await status(hit({ source: 'x' }, { origin: 'https://evil.example' }))).toBe(403)
    expect(await status(hit({ source: 'x' }, { origin: 'https://tonebase.example.evil.com' }))).toBe(403)
    expect(await status(hit({ source: 'x' }, { origin: null, referer: null }))).toBe(403)
    expect(await rows()).toHaveLength(0)
  })

  it('Aufruf ohne utm: nicht gezählt', async () => {
    expect(await status(hit({ path: '/' }))).toBe(400)
    expect(await status(hit({ source: '  ', campaign: '' }))).toBe(400)
    expect(await rows()).toHaveLength(0)
  })

  it('kürzt und säubert Werte', async () => {
    await hit({ source: `X${'a'.repeat(300)}`, medium: 'so\u0000cial', campaign: 'bit-con-012', content: 'C', path: `/${'p'.repeat(500)}?utm_source=x` })
    const [r] = await rows()
    expect(r!.source).toHaveLength(100)
    expect(r!.source.startsWith('xa')).toBe(true)
    expect(r!.medium).toBe('social')
    expect(r!.content).toBe('c')
    expect(r!.path).toHaveLength(200)
    expect(cleanPath('kein-slash')).toBe('/')
    expect(() => parseHit('x'.repeat(3000))).toThrow(CounterError)
    expect(() => parseHit('[1]')).toThrow(CounterError)
  })

  it('ohne utm_source: Referrer-Host als Quelle, eigener Host nicht', async () => {
    await hit({ campaign: 'bit-con-012', ref: 'www.news.example' })
    await hit({ campaign: 'bit-con-012', ref: 'tonebase.example' }, { ip: '203.0.113.9' })
    const r = await rows()
    expect(r.map(x => x.source).sort()).toEqual(['direkt', 'news.example'])
  })

  it('Bots werden still verworfen', async () => {
    expect(isBot('Googlebot/2.1')).toBe(true)
    expect(isBot('')).toBe(true)
    expect(isBot(UA)).toBe(false)
    expect(await status(hit({ source: 'x' }, { ua: 'Mozilla/5.0 (compatible; bingbot/2.0)' }))).toBe(204)
    expect(await rows()).toHaveLength(0)
  })

  it('Rate-Limit je IP', async () => {
    for (let i = 0; i < 30; i++) expect(await status(hit({ source: 'x', campaign: `c${i}` }))).toBe(0)
    expect(await status(hit({ source: 'x' }))).toBe(429)
    expect(await status(hit({ source: 'x' }, { ip: '198.51.100.1' }))).toBe(0)
  })

  it('archiviertes Projekt nimmt nichts an', async () => {
    await db.update(schema.projects).set({ archivedAt: new Date() }).where(eq(schema.projects.id, project.id))
    try {
      expect(await status(hit({ source: 'x' }))).toBe(404)
    }
    finally {
      await db.update(schema.projects).set({ archivedAt: null }).where(and(eq(schema.projects.id, project.id)))
    }
  })
})

interface Sent { url: string, body: Record<string, string> }

function runScript(href: string, attrs: Record<string, string> = { 'data-site': 'abcdefgh1234' }) {
  const sent: Sent[] = []
  const loc = new URL(href)
  const listeners: Record<string, () => void> = {}
  const history = {
    pushState(_s: unknown, _t: string, url: string) { const u = new URL(url, loc.href); loc.pathname = u.pathname; loc.search = u.search },
    replaceState(_s: unknown, _t: string, url: string) { const u = new URL(url, loc.href); loc.pathname = u.pathname; loc.search = u.search },
  }
  const ctx = {
    URL,
    URLSearchParams,
    JSON,
    location: loc,
    history,
    navigator: { webdriver: false },
    document: { referrer: 'https://bsky.app/profile/x', currentScript: { src: 'https://app.aimarage.com/z.js', getAttribute: (k: string) => attrs[k] ?? null } },
    addEventListener: (k: string, f: () => void) => { listeners[k] = f },
    fetch: (url: string, init: { body: string, credentials: string, keepalive: boolean }) => {
      expect(init.credentials).toBe('omit')
      expect(init.keepalive).toBe(true)
      sent.push({ url, body: JSON.parse(init.body) })
      return Promise.resolve()
    },
  } as Record<string, unknown>
  ctx.window = ctx
  runInNewContext(COUNTER_SCRIPT, ctx)
  return { sent, history, listeners }
}

describe('z.js', () => {
  it('meldet nur Aufrufe mit utm, ohne Query im Pfad', () => {
    expect(runScript('https://tonebase.example/preise?a=1').sent).toHaveLength(0)
    const { sent } = runScript('https://tonebase.example/preise?utm_source=bluesky&utm_medium=social&utm_campaign=bit-con-012&utm_term=t&ref=1')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://app.aimarage.com/z')
    expect(sent[0]!.body).toEqual({ site: 'abcdefgh1234', source: 'bluesky', medium: 'social', campaign: 'bit-con-012', term: 't', path: '/preise', ref: 'bsky.app' })
  })

  it('ohne data-site nichts', () => {
    expect(runScript('https://tonebase.example/?utm_source=x', {}).sent).toHaveLength(0)
  })

  it('SPA: neue utm nach pushState zählen, gleiche nicht doppelt', () => {
    const { sent, history, listeners } = runScript('https://tonebase.example/?utm_source=x&utm_campaign=a')
    history.pushState(null, '', '/preise?utm_source=x&utm_campaign=a')
    history.replaceState(null, '', '/preise')
    history.pushState(null, '', '/blog?utm_source=reddit&utm_campaign=b')
    listeners.popstate!()
    expect(sent.map(x => x.body.campaign)).toEqual(['a', 'b'])
    expect(sent[1]!.body.path).toBe('/blog')
  })
})
