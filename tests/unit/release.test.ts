import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listedPlatforms, platformOf } from '../../shared/utils/drafting'
import { parseTrackList, weekendPolicy } from '../../shared/utils/release'
import { apiActor, resolveBearer } from '../../server/lib/api/principal'
import { createApiToken } from '../../server/lib/api/tokens'
import { listConnections, upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { addFundusItem } from '../../server/lib/fundus'
import { buildMcpServer } from '../../server/lib/mcp/server'
import { targetAccounts, socialTarget } from '../../server/lib/publish'
import { buildReleasePlan, createRelease, pickImages, planRelease, ReleaseError, type ReleaseEnv, type ReleaseImage } from '../../server/lib/release'
import { upcomingReleases } from '../../server/lib/release-hints'
import { resetSecretCache } from '../../server/lib/secret'

const img = (id: string, tags: string[], usedCount = 0): ReleaseImage => ({ id, name: `${id}.jpg`, mime: 'image/jpeg', tags, usedCount, taskId: null })

const FUNDUS = [img('cover', ['cover', 'album']), img('wall', ['presse', 'pressefoto']), img('glass', ['presse', 'pressefoto']), img('jack', ['presse', 'portraet']), img('jill', ['presse', 'portraet'])]

const env = (o: Partial<ReleaseEnv> = {}): ReleaseEnv => ({
  today: '2026-10-11',
  postable: ['instagram', 'x'],
  excluded: [],
  busy: {},
  weekend: { social: true, human: false },
  hasBlog: true,
  bestTime: null,
  fundus: FUNDUS,
  ...o,
})

const REQ = { title: 'Superposition', kind: 'album' as const, releaseDate: '2026-10-20', link: 'https://tonebase.com/artists/the-wanderer/album/superposition', items: '1. The Observer Dies (3:41)\n2. Planck\n3. Moonbase' }

describe('Track-Liste', () => {
  it('aus Text: Nummern, Spiegelstriche und Dauer weg, ohne Doppelte', () => {
    expect(parseTrackList('01. The Observer Dies - 3:41\n- Planck\n3) Moonbase [4:02]\nplanck\n99 Luftballons')).toEqual(['The Observer Dies', 'Planck', 'Moonbase', '99 Luftballons'])
    expect(parseTrackList('Night Drive; Neon Rain, Old Technology')).toEqual(['Night Drive', 'Neon Rain', 'Old Technology'])
  })

  it('aus einer Unterlage: nur fortlaufend nummerierte Zeilen', () => {
    const doc = 'Pressetext\nDas Album erscheint am 20.10.2026.\n\nTracklist\n1. The Observer Dies\n2. Planck\n3. Moonbase\n\nKontakt: 2 Mails pro Woche'
    expect(parseTrackList(doc, { strict: true })).toEqual(['The Observer Dies', 'Planck', 'Moonbase'])
  })
})

describe('Wochenend-Regeln aus den Projekt-Regeln', () => {
  it('Firmen-Projekt: nichts am Wochenende', () => {
    expect(weekendPolicy(['Planung nur Montag bis Freitag (Zielgruppe Firmen), keine Posts am Wochenende.'])).toEqual({ social: false, human: false })
  })

  it('Musik-Projekt: Posts auch am Wochenende, Aufgaben für den Menschen nur werktags', () => {
    expect(weekendPolicy(['Wochenende: Social-Posts, die der Agent selbst erledigt (ohne Peters Mitarbeit), auch am Samstag und Sonntag einplanen - Musikpublikum hört und scrollt am Wochenende am meisten. Aufgaben, die Peter braucht, nur Montag bis Freitag.'])).toEqual({ social: true, human: false })
  })

  it('ohne Regel: Posts jeden Tag, Mensch werktags', () => {
    expect(weekendPolicy(['Never mention Suno.', null])).toEqual({ social: true, human: false })
  })
})

describe('Mehrere Plattformen in einer Aufgabe', () => {
  it('Kanal "Instagram, X" heißt beide, nicht nur die erste', () => {
    expect(listedPlatforms('Instagram, X')).toEqual(['instagram', 'x'])
    expect(listedPlatforms('Instagram')).toEqual([])
    expect(listedPlatforms('reddit:r/mcp, Blog')).toEqual([])
    expect(platformOf({ channel: 'Instagram, X', targetUrl: null, title: 'Serie 1/4', category: 'social' })).toBeNull()
    expect(platformOf({ channel: 'Instagram', targetUrl: null, title: 'Serie 1/4', category: 'social' })).toBe('instagram')
  })
})

describe('Release-Plan (ohne Datenbank)', () => {
  it('ein Post je Track plus Abschluss, täglich ab Release, Bilder im Wechsel, Album first', () => {
    const plan = buildReleasePlan(REQ, env())
    const social = plan.tasks.filter(t => t.kind === 'social')
    expect(social.map(t => [t.date, t.time])).toEqual([['2026-10-20', '18:00'], ['2026-10-21', '18:00'], ['2026-10-22', '18:00'], ['2026-10-23', '18:00']])
    expect(social.map(t => t.title)).toEqual(['Superposition-Serie 1/4: The Observer Dies', 'Superposition-Serie 2/4: Planck', 'Superposition-Serie 3/4: Moonbase', 'Superposition-Serie 4/4: das ganze Album'])
    expect(social.map(t => t.image?.id)).toEqual(['cover', 'glass', 'jack', 'cover'])
    expect(social[0]!.description).toContain('Album first')
    expect(social[0]!.description).toContain('Bild aus dem Fundus: cover.jpg (Tag cover)')
    expect(social[0]!.channel).toBeNull()
    expect(social[0]!.targetUrl).toBe(REQ.link)
    const other = Object.fromEntries(plan.tasks.filter(t => t.kind !== 'social').map(t => [t.kind, [t.date, t.category, t.draftKind, t.human]]))
    expect(other).toEqual({ blog: ['2026-10-20', 'content', 'article', false], pitch: ['2026-10-20', 'outreach', 'text', true], community: ['2026-10-22', 'community', 'post', true] })
    expect(plan.warnings).toEqual([])
  })

  it('Start in der Vergangenheit: ab morgen; Abstand und Uhrzeit aus Bestzeiten', () => {
    const plan = buildReleasePlan({ ...REQ, releaseDate: '2026-10-06', every: 2 }, env({ bestTime: '19:30' }))
    expect(plan.start).toBe('2026-10-12')
    expect(plan.timeSource).toBe('data')
    expect(plan.tasks.filter(t => t.kind === 'social').map(t => `${t.date} ${t.time}`)).toEqual(['2026-10-12 19:30', '2026-10-14 19:30', '2026-10-16 19:30', '2026-10-18 19:30'])
    expect(buildReleasePlan({ ...REQ, time: '17:00' }, env({ bestTime: '19:30' })).time).toBe('17:00')
  })

  it('Pacing: belegte Tage je Plattform werden übersprungen, nie zwei Posts am selben Tag', () => {
    const plan = buildReleasePlan(REQ, env({ busy: { '2026-10-21': ['x'], '2026-10-22': ['bluesky'] } }))
    const social = plan.tasks.filter(t => t.kind === 'social')
    expect(social.map(t => t.date)).toEqual(['2026-10-20', '2026-10-22', '2026-10-23', '2026-10-24'])
    expect(social.map(t => t.shifted)).toEqual([false, true, false, false])
  })

  it('Wochenende: ohne Wochenend-Posts rutscht die Serie auf Montag, Aufgaben für den Menschen immer werktags', () => {
    const off = buildReleasePlan({ ...REQ, releaseDate: '2026-10-23' }, env({ weekend: { social: false, human: false } }))
    expect(off.tasks.filter(t => t.kind === 'social').map(t => t.date)).toEqual(['2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28'])
    expect(off.tasks.find(t => t.kind === 'community')!.date).toBe('2026-10-26')
    const on = buildReleasePlan({ ...REQ, releaseDate: '2026-10-24' }, env())
    expect(on.tasks.filter(t => t.kind === 'social').map(t => t.date)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'])
    expect(on.tasks.find(t => t.kind === 'pitch')!.date).toBe('2026-10-26')
  })

  it('ohne Blog kein Anker-Artikel, Plattform-Auswahl landet im Kanal', () => {
    const plan = buildReleasePlan({ ...REQ, platforms: ['instagram', 'linkedin'] }, env({ hasBlog: false }))
    expect(plan.tasks.some(t => t.kind === 'blog')).toBe(false)
    expect(plan.warnings).toEqual(['Nicht verbunden oder ausgeschlossen, ausgelassen: LinkedIn', 'Kein Blog im Projekt: kein Anker-Artikel geplant'])
    expect(plan.tasks.find(t => t.kind === 'social')!.channel).toBe('Instagram')
    const two = buildReleasePlan({ ...REQ, platforms: ['instagram', 'x'] }, env({ postable: ['instagram', 'x', 'bluesky'] }))
    expect(two.tasks.find(t => t.kind === 'social')!.channel).toBe('Instagram, X')
  })

  it('Pressetext nur als Entwurf und nur mit Quelle (Kaltmail-Sperre)', () => {
    const withLink = buildReleasePlan({ ...REQ, press: true }, env())
    const press = withLink.tasks.find(t => t.kind === 'press')!
    expect(press.draftKind).toBe('text')
    expect(press.description).toContain('Keine Kaltmails')
    const noLink = buildReleasePlan({ ...REQ, link: null, press: true }, env())
    expect(noLink.tasks.some(t => t.kind === 'press')).toBe(false)
    expect(noLink.warnings).toContain('Ausgelassen (keine Kaltmails): Pressetext: Superposition')
  })

  it('Produkt-Launch: Features statt Tracks; ohne Konten keine Posts; Fehler bei falschen Eingaben', () => {
    const plan = buildReleasePlan({ title: 'Linkbox 5', kind: 'launch', releaseDate: '2026-11-02', items: 'MCP-Server\nRSS-Reader' }, env({ postable: [] }))
    expect(plan.tasks.some(t => t.kind === 'social')).toBe(false)
    expect(plan.warnings).toContain('Kein Social-Konto verbunden: keine Posts geplant')
    expect(plan.tasks.find(t => t.kind === 'pitch')!.title).toBe('Einreichung: Linkbox 5 bei Launch-Seiten und Verzeichnissen')
    expect(() => buildReleasePlan({ ...REQ, title: ' ' }, env())).toThrow(ReleaseError)
    expect(() => buildReleasePlan({ ...REQ, releaseDate: '2026-13-01' }, env())).toThrow(/Release-Datum/)
    expect(() => buildReleasePlan({ ...REQ, link: 'javascript:alert(1)' }, env())).toThrow(/Release-Link/)
  })

  it('Bilder: fehlt eine Sorte, kommt die nächste, ohne Fundus kein Bild', () => {
    expect(pickImages([img('only', ['portraet'])], 3).map(i => i?.id)).toEqual(['only', 'only', 'only'])
    expect(pickImages([], 2)).toEqual([null, null])
  })

  it('Release-Hinweise aus Fakten erkennen', () => {
    expect(upcomingReleases(['Neues Album "Nebula" erscheint am 20.11.2026', 'Album Monochrome (6.12.2025)', 'Termin am 2026-10-30'], '2026-10-11')).toEqual([{ text: 'Neues Album "Nebula" erscheint am 20.11.2026', date: '2026-11-20' }])
  })
})

describe('Release-Kampagne mit Datenbank', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let other: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect
  let foreign: typeof schema.projects.$inferSelect
  let userId: string

  beforeAll(async () => {
    process.env.MA_NOW = '2026-10-11T09:00:00+02:00'
    process.env.APP_SECRET = 'test-secret'
    process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'ma-release-'))
    resetSecretCache()
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { agentEnabled: false } }).returning())[0]!
    other = (await db.insert(schema.workspaces).values({ name: 'Fremd', settings: { agentEnabled: false } }).returning())[0]!
    const [u] = await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning()
    userId = u!.id
    await db.insert(schema.memberships).values({ workspaceId: ws.id, userId, role: 'owner' })
    project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'The Wanderer', code: 'THE', icon: 'T', rules: 'Pacing: max. 1 post per platform per day.\nWochenende: Social-Posts auch am Samstag und Sonntag einplanen. Aufgaben, die Peter braucht, nur Montag bis Freitag.', setup: { pacing: { perPlatformPerDay: 1 }, blog: 'https://thewandererai.com/blog' } }).returning())[0]!
    foreign = (await db.insert(schema.projects).values({ workspaceId: other.id, slug: 'fremd', name: 'Fremd', code: 'FRE', icon: 'F' }).returning())[0]!
    const a = await upsertConnection(db, ws.id, { provider: 'bluesky', platform: 'bluesky', name: '@tv', handle: 'tv.bsky.social', ext: { did: 'did:plc:tv' } }, { identifier: 'tv.bsky.social', password: 'x' }, { projectId: project.id })
    const b = await upsertConnection(db, ws.id, { provider: 'mastodon', platform: 'mastodon', name: '@tv', handle: 'tv@mastodon.social', ext: { instance: 'https://mastodon.social' } }, { accessToken: 'x' }, { projectId: project.id })
    await db.update(schema.projects).set({ setup: { ...project.setup, social: { accountIds: [a.id, b.id] } } }).where(eq(schema.projects.id, project.id))
    ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
    project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
    const jpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4])
    await addFundusItem(db, ws, project, { name: 'cover.jpg', data: jpg, tags: ['cover'], checked: true })
    await addFundusItem(db, ws, project, { name: 'wall.jpg', data: jpg, tags: ['presse', 'pressefoto'], checked: true })
    await addFundusItem(db, ws, project, { name: 'jack.jpg', data: jpg, tags: ['presse', 'portraet'], checked: true })
    await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'THE-SOC-001', title: 'Vorhandener Post', category: 'social', draftKind: 'post', dueDate: '2026-10-21', dueTime: '12:00' })
  })

  afterAll(async () => {
    delete process.env.MA_NOW
    delete process.env.APP_SECRET
    resetSecretCache()
    await close()
  })

  it('Vorschau beachtet vorhandene Posts, Konten und Wochenend-Regel, legt nichts an', async () => {
    expect(listConnections(ws)).toHaveLength(2)
    expect(socialTarget(ws, project)!.platforms.map(p => p.platform)).toEqual(['bluesky', 'mastodon'])
    const plan = await planRelease(db, ws, project, { ...REQ, link: REQ.link })
    expect(plan.platforms).toEqual(['bluesky', 'mastodon'])
    expect(plan.weekend).toEqual({ social: true, human: false })
    expect(plan.tasks.filter(t => t.kind === 'social').map(t => t.date)).toEqual(['2026-10-20', '2026-10-22', '2026-10-23', '2026-10-24'])
    const [{ n }] = await db.select({ n: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.projectId, project.id)).then(r => [{ n: r.length }])
    expect(n).toBe(1)
  })

  it('Anlegen: Aufgaben mit Kampagne, Kanal und vorgemerktem Fundus-Bild; zweites Mal abgelehnt', async () => {
    const r = await createRelease(db, ws, project, { ...REQ, platforms: ['bluesky'] }, { userId })
    expect(r.tasks.map(t => t.code)).toEqual(['THE-CON-001', 'THE-SOC-002', 'THE-OUT-001', 'THE-SOC-003', 'THE-COM-001', 'THE-SOC-004', 'THE-SOC-005'])
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.campaignId, r.campaignId))
    expect(rows).toHaveLength(7)
    expect(new Set(rows.map(t => t.origin))).toEqual(new Set(['release:superposition']))
    const first = rows.find(t => t.code === 'THE-SOC-002')!
    expect([first.channel, first.dueDate, first.dueTime, first.assigneeUserId, first.targetUrl]).toEqual(['Bluesky', '2026-10-20', '18:00', userId, REQ.link])
    expect(targetAccounts(socialTarget(ws, project), first).map(p => p.platform)).toEqual(['bluesky'])
    const cover = (await db.select().from(schema.mediaLibrary).where(eq(schema.mediaLibrary.projectId, project.id))).find(m => m.name === 'cover.jpg')!
    expect(cover.taskId).toBe(first.id)
    const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, r.campaignId))
    expect([c!.name, c!.startDate, c!.endDate]).toEqual(['Release: Superposition', '2026-10-20', '2026-10-24'])
    await expect(createRelease(db, ws, project, REQ, { userId })).rejects.toThrow(/schon angelegt/)
  })

  it('Mandanten: fremde Unterlage und fremdes Projekt über MCP gehen nicht', async () => {
    const [doc] = await db.insert(schema.projectDocuments).values({ workspaceId: other.id, projectId: foreign.id, name: 'tracks.txt', type: 'text', mime: 'text/plain', size: 10, file: 'x', text: '1. Geheim\n2. Fremd' }).returning()
    await expect(planRelease(db, ws, project, { ...REQ, title: 'Anderes', items: null, documentId: doc!.id })).rejects.toThrow(/Unterlage nicht gefunden/)
    const { token } = await createApiToken(db, { userId, workspaceId: ws.id, name: 't', scope: 'write' })
    const principal = (await resolveBearer(db, token))!
    const server = buildMcpServer({ db, actor: await apiActor(db, principal), principal, deps: {} }, 'http://localhost:3210')
    const [x, y] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(x), client.connect(y)])
    const denied = await client.callTool({ name: 'release_planen', arguments: { projekt: 'fremd', titel: 'X', art: 'album', release_datum: '2026-11-01' } })
    expect(denied.isError).toBe(true)
    const preview = await client.callTool({ name: 'release_planen', arguments: { projekt: 'thewanderer', titel: 'Nebula', art: 'single', release_datum: '2026-11-03', tracks: 'Nebula' } })
    expect(preview.isError).toBeFalsy()
    const out = JSON.parse((preview.content as { text: string }[])[0]!.text) as { preview: boolean, tasks: { title: string }[] }
    expect(out.preview).toBe(true)
    expect(out.tasks.map(t => t.title)).toContain('Nebula-Serie 1/2: Nebula')
    expect(await db.select().from(schema.campaigns).where(eq(schema.campaigns.name, 'Release: Nebula'))).toHaveLength(0)
  })
})
