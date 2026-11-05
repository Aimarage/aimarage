import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { updateSettings, sealAppSecret } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { resetSecretCache } from '../../server/lib/secret'
import { finishGoogle, googleAuthorizeUrl, googleRefreshToken, pickProperty, publicGoogle, searchSummary, seoDigest, startGoogle, syncProjectSearch } from '../../server/lib/search-console'
import { analyzePage, auditSite, pageIssues, saveAudit, seoGroupTasks, seoTasks, shownIssues } from '../../server/lib/seo-audit'
import { searchTerms } from '../../server/lib/api/service'

const APP = 'http://localhost:3210'
const SECRET = 'GOCSPX-geheim-1234567890'
const REFRESH = '1//refresh-token-abcdefghijkl'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect

async function reload() {
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
}

const html = (o: { title?: string, desc?: string, h1?: string[], body?: string, extra?: string, links?: string[] }) => `<!doctype html><html lang="de"><head>${o.title !== undefined ? `<title>${o.title}</title>` : ''}${o.desc !== undefined ? `<meta name="description" content="${o.desc}">` : ''}${o.extra ?? ''}</head><body>${(o.h1 ?? []).map(h => `<h1>${h}</h1>`).join('')}<p>${o.body ?? ''}</p>${(o.links ?? []).map(l => `<a href="${l}">x</a>`).join('')}</body></html>`

const words = (n: number) => Array.from({ length: n }, (_, i) => `Wort${i}`).join(' ')

function site(pages: Record<string, { status?: number, body?: string, type?: string }>) {
  const calls: string[] = []
  const f = async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? 'GET'} ${url}`)
    const p = pages[url]
    if (!p) return new Response('nicht da', { status: 404, headers: { 'content-type': 'text/html' } })
    return new Response(p.body ?? '', { status: p.status ?? 200, headers: { 'content-type': p.type ?? 'text/html; charset=utf-8' } })
  }
  return { f, calls }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-09T09:00:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'chatsite', name: 'chatsite', code: 'AMW', icon: 'A', url: 'https://chatsite.site', languages: ['de', 'en'] }).returning())[0]!
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('SEO-Prüfung', () => {
  it('erkennt Probleme einer Seite', () => {
    const p = analyzePage(html({ title: 'Ein sehr langer Seitentitel, der weit über sechzig Zeichen hinausgeht und abgeschnitten wird', h1: ['A', 'B'], body: `${words(40)}<img src="a.png"><img src="b.png" alt="">`, extra: '<meta name="robots" content="noindex,follow">' }), 'https://x.example/de/funktionen', { status: 200, ms: 2500, bytes: 1000 })
    expect(p.h1Count).toBe(2)
    expect(p.imgNoAlt).toBe(1)
    expect(p.noindex).toBe(true)
    const codes = pageIssues([p], { multilingual: true }).map(i => i.code)
    expect(codes).toEqual(expect.arrayContaining(['noindex', 'title_long', 'desc_missing', 'h1_multiple', 'img_alt', 'thin', 'canonical_missing', 'hreflang_missing', 'slow']))
    const ok = analyzePage(html({ title: 'Kurz', desc: 'Beschreibung', h1: ['Eins'], body: words(400), extra: '<link rel="canonical" href="https://x.example/"><link rel="alternate" hreflang="en" href="https://x.example/en">' }), 'https://x.example/', { status: 200, ms: 100, bytes: 1000 })
    expect(pageIssues([ok], { multilingual: true })).toEqual([])
  })

  it('crawlt mit robots.txt und Sitemap, findet kaputte Links, schlimmste zuerst', async () => {
    const good = (t: string, links: string[] = []) => html({ title: t, desc: 'Beschreibung', h1: [t], body: words(300), extra: '<link rel="canonical" href="https://s.example/">', links })
    const { f, calls } = site({
      'https://s.example/robots.txt': { body: 'User-agent: *\nDisallow: /admin\nSitemap: https://s.example/sitemap.xml', type: 'text/plain' },
      'https://s.example/sitemap.xml': { body: '<urlset><url><loc>https://s.example/preise</loc></url><url><loc>https://s.example/admin/x</loc></url></urlset>', type: 'application/xml' },
      'https://s.example/': { body: good('Start', ['/preise', '/weg', '/admin/geheim', '/team']) },
      'https://s.example/preise': { body: html({ h1: [], body: words(10) }) },
      'https://s.example/team': { body: good('Start') },
    })
    const r = await auditSite('https://s.example/', { fetchImpl: f, delayMs: 0, maxPages: 3 })
    expect(r.error).toBeNull()
    expect(calls.some(c => c.includes('/admin'))).toBe(false)
    expect(r.pages.map(p => p.url)).toEqual(['https://s.example/', 'https://s.example/preise', 'https://s.example/team'])
    expect(r.issues[0]!.severity).toBe(3)
    expect(r.issues.some(i => i.code === 'http_error' && i.url.endsWith('/weg') && i.params.from === '/')).toBe(true)
    expect(r.issues.some(i => i.code === 'title_missing' && i.url.endsWith('/preise'))).toBe(true)
    const sev = r.issues.map(i => i.severity)
    expect([...sev].sort((a, b) => b - a)).toEqual(sev)
  })

  it('respektiert ein Verbot in robots.txt', async () => {
    const { f, calls } = site({ 'https://n.example/robots.txt': { body: 'User-agent: *\nDisallow: /', type: 'text/plain' } })
    const r = await auditSite('https://n.example/', { fetchImpl: f, delayMs: 0 })
    expect(r.error).toMatch(/robots/)
    expect(calls).toEqual(['GET https://n.example/robots.txt'])
  })

  it('legt Pflege-Aufgaben mit Vorschlag an, nicht doppelt, und erledigt behobene', async () => {
    const long = 'Chatsite - Frag deine Website alles, KI-Chat für jede Seite ohne Programmierung'
    const pages = [analyzePage(html({ title: long, desc: 'x', h1: ['Frag deine Website'], body: words(300), extra: '<link rel="canonical" href="https://chatsite.site/de/funktionen"><link rel="alternate" hreflang="en" href="https://chatsite.site/features">' }), 'https://chatsite.site/de/funktionen', { status: 200, ms: 100, bytes: 1000 })]
    const audit = { url: 'https://chatsite.site/', checkedAt: '', pages: pages.map(({ links: _, ...p }) => p), issues: pageIssues(pages, { multilingual: true }), linksChecked: 0, pagespeed: null, error: null }
    expect(audit.issues.map(i => i.code)).toEqual(['title_long'])
    const r = await seoTasks(db, ws, project, audit)
    expect(r.created).toBe(1)
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id))
    expect(t!.title).toBe('Seitentitel von /de/funktionen kürzen')
    expect(t!.category).toBe('pflege')
    expect(t!.humanStep).toBeTruthy()
    expect(t!.description).toContain('Auftrag für Claude Code oder Entwickler (kopieren):')
    expect(t!.description).toContain('(79 Zeichen, gut sind bis 60) -> "Chatsite - Frag deine Website alles, KI-Chat für jede Seite')
    expect(t!.description).toContain(`Aufgabe ${t!.code} in Aimarage erledigen`)
    expect((await seoTasks(db, ws, project, audit)).created).toBe(0)
    const fixed = await seoTasks(db, ws, project, { ...audit, issues: [] })
    expect(fixed.closed).toBe(1)
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, t!.id)))[0]!.status).toBe('erledigt')
    await saveAudit(db, project.id, audit)
  })

  it('bündelt gleichartige Probleme zu einer Aufgabe je Art und ersetzt alte Einzelaufgaben', async () => {
    const [p2] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'linkbox', name: 'linkbox', code: 'BMX', icon: 'B', url: 'https://linkbox.app' }).returning()
    const old = (await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p2!.id, code: 'BMX-PFL-001', title: 'Seitentitel von /a kürzen', category: 'pflege', dueDate: '2026-10-09', humanStep: 'Auf der Website ändern', origin: 'seo:title_long:/a' }).returning())[0]!
    const issue = (code: 'title_long' | 'hreflang_missing', path: string) => ({ code, severity: 2 as const, url: `https://linkbox.app${path}`, label: code === 'title_long' ? 'Seitentitel zu lang' : 'Sprachverweise fehlen', params: {} })
    const paths = ['/a', '/b', '/c', '/d', '/e']
    const audit = { url: 'https://linkbox.app/', checkedAt: '', pages: paths.map(x => ({ url: `https://linkbox.app${x}`, status: 200, ms: 100, bytes: 1, title: `Ein sehr langer Titel für ${x} der über sechzig Zeichen geht, wirklich sehr lang`, description: null, h1: 'Seite', h1Count: 1, words: 300, excerpt: '', canonical: null, hreflang: 0, noindex: false, imgNoAlt: 0, lang: 'de' })), issues: [...paths.map(x => issue('title_long', x)), issue('hreflang_missing', '/a'), issue('hreflang_missing', '/b')], linksChecked: 0, pagespeed: null, error: null }
    const r = await seoTasks(db, ws, p2!, audit)
    expect(r.created).toBe(2)
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, p2!.id))
    const title = rows.find(t => t.origin === 'seo-group:title')!
    expect(title.title).toBe('Seitentitel auf 5 Seiten verbessern')
    for (const x of paths) expect(title.description).toContain(`https://linkbox.app${x}: Seitentitel zu lang`)
    expect(rows.find(t => t.origin === 'seo-group:hreflang')!.title).toBe('Sprachverweise (hreflang) auf 2 Seiten ergänzen')
    expect(rows.find(t => t.id === old.id)!.status).toBe('verworfen')
    const again = await seoTasks(db, ws, p2!, { ...audit, issues: audit.issues.filter(i => i.url.endsWith('/a') && i.code === 'title_long') })
    expect(again).toEqual({ created: 0, closed: 1 })
    const upd = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, title.id)))[0]!
    expect(upd.title).toBe('Seitentitel von /a kürzen')
    expect(upd.code).toBe(title.code)
  })

  it('macht aus jeder Fund-Art eine Aufgabe für Claude, auch kleine, ohne wenig Text auf Pflichtseiten', async () => {
    const [p3] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'The Wanderer', code: 'THE', icon: 'T', url: 'https://thewanderer.example' }).returning()
    const page = (path: string, o: { desc?: string, words?: number, img?: number } = {}) => analyzePage(html({ title: `Seite ${path}`, desc: o.desc ?? 'Kurz', h1: ['Eins'], body: `${words(o.words ?? 300)}${'<img src="x.png">'.repeat(o.img ?? 0)}`, extra: `<link rel="canonical" href="https://thewanderer.example${path}">` }), `https://thewanderer.example${path}`, { status: 200, ms: 100, bytes: 1000 })
    const pages = [page('/a', { desc: 'x'.repeat(200), img: 2 }), page('/b', { words: 40 }), page('/impressum', { words: 30 }), page('/de/datenschutz', { words: 30 }), page('/kontakt', { words: 20 })]
    const issues = pageIssues(pages, { multilingual: false })
    expect(issues.map(i => `${i.code} ${i.url.slice(27)}`).sort()).toEqual(['desc_long /a', 'img_alt /a', 'thin /b'])
    expect(shownIssues([{ code: 'thin', severity: 1, url: 'https://x.example/impressum', label: '', params: {} }])).toEqual([])
    const audit = { url: 'https://thewanderer.example/', checkedAt: '2026-10-09T07:00:00.000Z', pages: pages.map(({ links: _, ...p }) => p), issues, linksChecked: 0, pagespeed: null, error: null }
    expect((await seoTasks(db, ws, p3!, audit)).created).toBe(3)
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, p3!.id))
    expect(rows.map(t => t.origin).sort()).toEqual(['seo-group:desc', 'seo-group:img', 'seo-group:thin'])
    expect(rows.every(t => t.forClaude && t.prio === 'P3' && t.description!.includes('Auftrag für Claude Code'))).toBe(true)
    expect(rows.find(t => t.origin === 'seo-group:thin')!.title).toBe('Mehr Text auf /b')
    const tasks = await seoGroupTasks(db, p3!.id, audit.checkedAt)
    expect(Object.keys(tasks).sort()).toEqual(['desc', 'img', 'thin'])

    const img = rows.find(t => t.origin === 'seo-group:img')!
    const thin = rows.find(t => t.origin === 'seo-group:thin')!
    await db.update(schema.tasks).set({ status: 'erledigt', doneAt: new Date('2026-10-09T06:00:00Z'), updatedAt: new Date('2026-10-09T06:00:00Z') }).where(eq(schema.tasks.id, img.id))
    await db.update(schema.tasks).set({ status: 'verworfen', updatedAt: new Date('2026-10-09T06:00:00Z') }).where(eq(schema.tasks.id, thin.id))
    expect(Object.keys(await seoGroupTasks(db, p3!.id, audit.checkedAt)).sort()).toEqual(['desc'])
    const again = await seoTasks(db, ws, p3!, audit)
    expect(again.created).toBe(1)
    const now2 = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, p3!.id))
    expect(now2.filter(t => t.origin === 'seo-group:img' && t.status === 'geplant')).toHaveLength(1)
    expect(now2.filter(t => t.origin === 'seo-group:thin' && t.status === 'geplant')).toHaveLength(0)

    const forced = await seoTasks(db, ws, p3!, audit, { only: 'thin' })
    expect(forced).toEqual({ created: 1, closed: 0 })
    expect((await seoGroupTasks(db, p3!.id, audit.checkedAt)).thin!.status).toBe('geplant')

    const fixed = await seoTasks(db, ws, p3!, { ...audit, issues: issues.filter(i => i.code !== 'img_alt') })
    expect(fixed.closed).toBe(1)
  })
})

describe('Google Search Console', () => {
  it('Anmelde-Adresse fragt nur Lesezugriff und dauerhaften Zugang', () => {
    const u = new URL(googleAuthorizeUrl({ clientId: 'cid', redirectUri: `${APP}/api/connect/google/callback` }, 'st'))
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/webmasters.readonly')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('redirect_uri')).toBe(`${APP}/api/connect/google/callback`)
  })

  it('wählt die passende Property, auch sc-domain', () => {
    const sites = [{ siteUrl: 'https://other.example/', permissionLevel: 'siteOwner' }, { siteUrl: 'https://chatsite.site/', permissionLevel: 'siteOwner' }]
    expect(pickProperty(sites, 'https://www.chatsite.site/de')).toBe('https://chatsite.site/')
    expect(pickProperty([...sites, { siteUrl: 'sc-domain:chatsite.site', permissionLevel: 'siteFullUser' }], 'chatsite.site')).toBe('sc-domain:chatsite.site')
    expect(pickProperty(sites, 'https://nope.example')).toBeNull()
  })

  it('verbindet, speichert den Zugang verschlüsselt und holt Zahlen idempotent', async () => {
    await updateSettings(db, ws.id, s => ({ ...s, apps: { ...s.apps, google: { clientId: 'cid.apps.googleusercontent.com', secret: sealAppSecret(ws.id, 'google', SECRET) } } }))
    await reload()
    const url = await startGoogle(db, ws, project.id, APP)
    const state = new URL(url).searchParams.get('state')!
    await reload()
    const bodies: string[] = []
    const day = (d: string) => d
    const f = async (u: string, init: RequestInit) => {
      bodies.push(String(init.body ?? ''))
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        const b = new URLSearchParams(String(init.body))
        if (b.get('grant_type') === 'authorization_code') return Response.json({ access_token: 'at1', refresh_token: REFRESH, scope: 'https://www.googleapis.com/auth/webmasters.readonly' })
        expect(b.get('refresh_token')).toBe(REFRESH)
        return Response.json({ access_token: 'at2' })
      }
      if (u.endsWith('/sites')) return Response.json({ siteEntry: [{ siteUrl: 'sc-domain:chatsite.site', permissionLevel: 'siteOwner' }, { siteUrl: 'https://x.example/', permissionLevel: 'siteUnverifiedUser' }] })
      if (u.includes('/searchAnalytics/query')) {
        expect(u).toContain(encodeURIComponent('sc-domain:chatsite.site'))
        const q = JSON.parse(String(init.body)) as { dimensions: string[] }
        const dims = q.dimensions.join(',')
        if (dims === 'date') return Response.json({ rows: [{ keys: [day('2026-10-01')], clicks: 5, impressions: 400, position: 8 }, { keys: ['2026-09-20'], clicks: 3, impressions: 100, position: 6 }] })
        if (dims === 'date,page') return Response.json({ rows: [{ keys: ['2026-10-01', 'https://chatsite.site/features'], clicks: 2, impressions: 50, position: 9 }, { keys: ['2026-09-20', 'https://chatsite.site/features'], clicks: 2, impressions: 50, position: 4 }] })
        return Response.json({ rows: [
          { keys: ['2026-10-01', 'website chatbot', 'https://chatsite.site/'], clicks: 4, impressions: 30, position: 3 },
          { keys: ['2026-10-01', 'ki chat für website', 'https://chatsite.site/features'], clicks: 0, impressions: 300, position: 9.5 },
        ] })
      }
      return new Response('?', { status: 404 })
    }
    const r = await finishGoogle(db, ws, 'code123', state, APP, f as typeof fetch)
    expect(r.property).toBe('sc-domain:chatsite.site')
    await reload()
    expect(JSON.stringify(project.setup)).not.toContain(REFRESH)
    expect(googleRefreshToken(ws.id, project.id, project.setup.google)).toBe(REFRESH)
    expect(JSON.stringify(publicGoogle(project.setup.google))).not.toContain(project.setup.google!.secret!.enc)
    expect((ws.settings.oauthStates ?? []).some(x => x.state === state)).toBe(false)
    expect(await syncProjectSearch(db, ws, project, APP, f as typeof fetch)).toBe(6)
    expect(await syncProjectSearch(db, ws, project, APP, f as typeof fetch)).toBe(6)
    expect(await db.select().from(schema.searchStats)).toHaveLength(6)
    const s = await searchSummary(db, project.id, '2026-09-11', '2026-10-08')
    expect(s.clicks).toBe(8)
    expect(s.impressions).toBe(500)
    expect(s.top[0]!.query).toBe('website chatbot')
    expect(s.chances.map(c => c.query)).toEqual(['ki chat für website'])
    expect(s.dropped).toEqual([{ page: 'https://chatsite.site/features', before: 4, now: 9, impressions: 100, source: 'google' }])
    const text = await seoDigest(db, project, '2026-10-09')
    expect(text).toContain('Chancen')
    expect(text).toContain('"ki chat für website"')
    expect(text).toContain('/features: von 4 auf 9')
    expect(text).toContain('Seitentitel zu lang')
    expect(await seoDigest(db, project, '2026-10-09', { short: true })).toContain('"website chatbot"')
    await reload()
    expect(project.setup.google?.lastSync).toBeTruthy()
  })

  it('MCP/REST: suchbegriffe liefert Zahlen und Prüfung, ohne Geheimnisse', async () => {
    const [u] = await db.insert(schema.users).values({ email: 'p@x.example', name: 'Peter' }).returning()
    await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: u!.id, role: 'owner' })
    const out = await searchTerms(db, { workspace: ws, userId: u!.id, userName: 'Peter', role: 'owner', access: { all: true, ids: [] } }, 'chatsite', {})
    expect(out.connected).toBe(true)
    expect(out.impressions).toBe(500)
    expect(out.seoCheck?.problems[0]?.problem).toMatch(/Seitentitel/)
    expect(JSON.stringify(out)).not.toMatch(/refresh|GOCSPX|v1\./)
  })

  it('abgelaufener Zugang wird verständlich gemeldet', async () => {
    const f = async () => Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 })
    await expect(syncProjectSearch(db, ws, project, APP, f as typeof fetch)).rejects.toThrow(/neu verbinden/)
    await reload()
    expect(project.setup.google?.error).toMatch(/Google Search Console abgelaufen oder widerrufen, bitte neu verbinden/)
  })

  it('Neu verbinden behält Website und bisherige Zahlen', async () => {
    await reload()
    const before = (await db.select().from(schema.searchStats)).length
    expect(before).toBeGreaterThan(0)
    const url = await startGoogle(db, ws, project.id, APP)
    const state = new URL(url).searchParams.get('state')!
    await reload()
    const f = async (u: string) => {
      if (u.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at9', refresh_token: '1//neu', scope: 'https://www.googleapis.com/auth/webmasters.readonly' })
      if (u.endsWith('/sites')) return Response.json({ siteEntry: [{ siteUrl: 'https://chatsite.site/', permissionLevel: 'siteOwner' }, { siteUrl: 'sc-domain:chatsite.site', permissionLevel: 'siteOwner' }] })
      return new Response('?', { status: 404 })
    }
    const r = await finishGoogle(db, ws, 'code9', state, APP, f as typeof fetch)
    expect(r.property).toBe('sc-domain:chatsite.site')
    await reload()
    expect(project.setup.google?.error).toBeNull()
    expect(project.setup.google?.lastSync).toBeTruthy()
    expect(googleRefreshToken(ws.id, project.id, project.setup.google)).toBe('1//neu')
    expect(await db.select().from(schema.searchStats)).toHaveLength(before)
  })
})
