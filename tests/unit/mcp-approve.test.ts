import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runDraftTask } from '../../server/lib/agent'
import { upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { apiActor, resolveBearer, type ApiPrincipal } from '../../server/lib/api/principal'
import { createApiToken } from '../../server/lib/api/tokens'
import { buildMcpServer } from '../../server/lib/mcp/server'
import { checkLinks, draftStamp, reviewForMcp, stopMcpApproval, stopRelease } from '../../server/lib/mcp-approve'
import { releasedDrafts } from '../../server/lib/approval-lists'
import { approveAndSchedule } from '../../server/services/approve'
import { trustSuggestions } from '../../server/lib/trust'
import { resetSecretCache } from '../../server/lib/secret'
import { linksIn, mcpApproveConfig, mcpKindOf, textProblems } from '../../shared/utils/mcp-approve'

let db: Db
let close: () => Promise<void>
let wsId: string
let peterId: string
let projectId: string
let seq = 0
const BASE = 'http://localhost:3210'
const REASON = 'Regeln gelesen, Fakten und Link geprüft, Ton passt, keine Platzhalter, Länge passt für Bluesky.'

const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } })
const llmReply = (msg: Record<string, unknown>) => json({ model: 'mock', choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
const linkOk = async () => new Response(null, { status: 200 })

async function principal(opts: { scope?: 'read' | 'write', approve?: boolean } = {}): Promise<ApiPrincipal> {
  const { token } = await createApiToken(db, { userId: peterId, workspaceId: wsId, name: 'Claude Code', scope: opts.scope ?? 'write', canApprove: opts.approve })
  return (await resolveBearer(db, token))!
}

async function client(p: ApiPrincipal, deps: Record<string, unknown> = { webFetch: linkOk }) {
  const server = buildMcpServer({ db, actor: await apiActor(db, p), principal: p, deps }, BASE)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(a), c.connect(b)])
  return c
}

function data(r: unknown): Record<string, unknown> {
  return JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
}

function text(r: unknown): string {
  return (r as { content: { text: string }[] }).content[0]!.text
}

async function settings(m: Record<string, unknown>) {
  const [w] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId))
  await db.update(schema.workspaces).set({ settings: { ...w!.settings, mcpApprove: { ...w!.settings.mcpApprove, ...m } } }).where(eq(schema.workspaces.id, wsId))
}

async function makeDraft(o: { body?: string, category?: 'social' | 'content' | 'community' | 'outreach', kind?: 'post' | 'mail' | 'article' | 'text', date?: string, time?: string | null } = {}) {
  seq++
  const kind = o.kind ?? 'post'
  const [t] = await db.insert(schema.tasks).values({ workspaceId: wsId, projectId, code: `TV-SOC-${String(seq).padStart(3, '0')}`, title: `Post ${seq}`, category: o.category ?? 'social', dueDate: o.date ?? '2026-10-13', dueTime: o.time === undefined ? '08:00' : o.time, draftKind: kind, status: 'entwurf_fertig', channel: 'Bluesky' }).returning()
  const [d] = await db.insert(schema.drafts).values({ taskId: t!.id, kind, body: o.body ?? 'Night Drive is out now: https://thewanderer.example/night-drive #synthwave', byAgent: true, recipient: kind === 'mail' ? 'a@b.example' : null, subject: kind === 'mail' ? 'Hallo' : null, createdAt: new Date('2026-10-13T06:10:00Z') }).returning()
  return { task: t!, draft: d! }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  const [w] = await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' }, publishLive: true } }).returning()
  wsId = w!.id
  const [peter] = await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning()
  peterId = peter!.id
  await db.insert(schema.memberships).values({ workspaceId: wsId, userId: peterId, role: 'owner' })
  const [p] = await db.insert(schema.projects).values({ workspaceId: wsId, slug: 'thewanderer', name: 'thewanderer', code: 'TV', icon: 'music', url: 'https://thewanderer.example', rules: 'Nie "Jonas" erwähnen.' }).returning()
  projectId = p!.id
  const conn = await upsertConnection(db, wsId, { provider: 'bluesky', platform: 'bluesky', name: '@tv', handle: 'tv.bsky.social', ext: { did: 'did:plc:tv' } }, { identifier: 'tv.bsky.social', password: 'app-pass' }, { projectId })
  await db.update(schema.projects).set({ setup: { social: { accountIds: [conn.id] } } }).where(eq(schema.projects.id, projectId))
})

afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

beforeEach(async () => {
  await db.delete(schema.activity).where(and(eq(schema.activity.workspaceId, wsId), eq(schema.activity.action, 'mcp_approved')))
  await settings({ enabled: true, perDay: 10, delayMin: 30, kinds: ['content', 'social', 'community'], offProjects: [] })
})

describe('Regeln ohne Datenbank', () => {
  it('Standard aus, 30 Minuten, 10 pro Tag, Artikel/Social/Community', () => {
    expect(mcpApproveConfig(undefined)).toEqual({ enabled: false, kinds: ['content', 'social', 'community'], delayMin: 30, perDay: 10, offProjects: [] })
    expect(mcpApproveConfig({ enabled: true, kinds: ['social', 'outreach'], delayMin: -5, perDay: 999 })).toMatchObject({ kinds: ['social'], delayMin: 0, perDay: 100 })
    expect(mcpApproveConfig({ enabled: true, kinds: ['social', 'mail'] }).kinds).toEqual(['social', 'mail'])
  })

  it('Mail-Antworten eigene Art, Kaltakquise nie', () => {
    expect(mcpKindOf({ category: 'social', draftKind: 'post' }, { kind: 'post' })).toBe('social')
    expect(mcpKindOf({ category: 'pflege', draftKind: 'mail' }, { kind: 'mail' })).toBe('mail')
    expect(mcpKindOf({ category: 'social', draftKind: 'mail' }, { kind: 'post' })).toBeNull()
    expect(mcpKindOf({ category: 'outreach', draftKind: 'mail' }, { kind: 'mail' })).toBeNull()
    expect(mcpKindOf({ category: 'launch', draftKind: 'text' }, { kind: 'text' })).toBeNull()
  })

  it('lange Striche und Platzhalter, Links', () => {
    expect(textProblems(['Neu — jetzt'])).toHaveLength(1)
    expect(textProblems(['Hier [..] einfügen'])).toHaveLength(1)
    expect(textProblems(['TODO Link'])).toHaveLength(1)
    expect(textProblems(['Alles gut - [Link](https://a.example)'])).toEqual([])
    expect(linksIn(['Siehe https://a.example/x). Und (https://b.example/y).'])).toEqual(['https://a.example/x', 'https://b.example/y'])
  })

  it('Link-Prüfung: 401 und 403 gelten als erreichbar, 410 und 5xx nicht', async () => {
    const f = async (url: string) => new Response(null, { status: Number(url.split('/').pop()) })
    const bad = await checkLinks(['https://a.example/401', 'https://a.example/403', 'https://a.example/410', 'https://a.example/500', 'https://a.example/503'], f)
    expect(bad).toEqual(['https://a.example/410 (410)', 'https://a.example/500 (500)', 'https://a.example/503 (503)'])
  })

  it('Link-Prüfung: 2xx/3xx ok, 404 und Fehler nicht', async () => {
    const f = async (url: string, init: RequestInit) => {
      if (url.includes('moved')) return new Response(null, { status: 301 })
      if (url.includes('nohead')) return new Response(null, { status: init.method === 'HEAD' ? 405 : 200 })
      if (url.includes('down')) throw new Error('timeout')
      return new Response(null, { status: url.includes('gone') ? 404 : 200 })
    }
    const bad = await checkLinks(['https://a.example/ok', 'https://a.example/moved', 'https://a.example/nohead', 'https://a.example/gone', 'https://a.example/down'], f)
    expect(bad).toEqual(['https://a.example/gone (404)', 'https://a.example/down (nicht erreichbar)'])
  })
})

describe('MCP-Werkzeug freigeben', () => {
  it('nur mit Freigabe-Schlüssel sichtbar und aufrufbar', async () => {
    const plain = await client(await principal())
    expect((await plain.listTools()).tools.map(t => t.name)).not.toContain('freigeben')
    expect((await plain.callTool({ name: 'freigeben', arguments: { code: 'x', stand: 'v1-abc', pruefung: REASON } })).isError).toBe(true)
    const read = await client(await principal({ scope: 'read', approve: true }))
    expect((await read.listTools()).tools.map(t => t.name)).not.toContain('freigeben')
    const key = await client(await principal({ approve: true }))
    const tools = (await key.listTools()).tools
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['freigeben', 'aufgabe_gespraech', 'aufgabe_antworten']))
    expect(tools.find(t => t.name === 'freigeben')!.annotations).toMatchObject({ readOnlyHint: false })
  })

  it('Schalter aus: abgelehnt', async () => {
    await settings({ enabled: false })
    const { draft } = await makeDraft()
    const c = await client(await principal({ approve: true }))
    const r = await c.callTool({ name: 'freigeben', arguments: { entwurf_id: draft.id, stand: draftStamp(draft), pruefung: REASON } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/ausgeschaltet/)
  })

  it('Freigabe mit Einspruchsfrist, Log, Notiz; Stoppen setzt zurück', async () => {
    const { task, draft } = await makeDraft()
    const c = await client(await principal({ approve: true }))
    const list = data(await c.callTool({ name: 'freigaben_liste', arguments: { projekt: 'thewanderer' } }))
    const item = (list.drafts as { draftId: string, stand: string, mcpAllowed: boolean, links: string[] }[]).find(d => d.draftId === draft.id)!
    expect(item.mcpAllowed).toBe(true)
    expect(item.links).toEqual(['https://thewanderer.example/night-drive'])
    expect(list.mcpApprove).toMatchObject({ enabled: true, thisKey: true, remainingToday: 10 })

    const short = await c.callTool({ name: 'freigeben', arguments: { entwurf_id: draft.id, stand: item.stand, pruefung: 'passt' } })
    expect(short.isError).toBe(true)
    const stale = await c.callTool({ name: 'freigeben', arguments: { entwurf_id: draft.id, stand: 'v1-000000000000', pruefung: REASON } })
    expect(text(stale)).toMatch(/geändert/)

    const ok = data(await c.callTool({ name: 'freigeben', arguments: { code: task.code, stand: item.stand, pruefung: REASON } }))
    expect(ok.goesOut).toBe(true)
    expect(ok.releaseAt).toBe('2026-10-13T06:45:00.000Z')
    expect(ok.remainingToday).toBe(9)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(d).toMatchObject({ status: 'freigegeben', approvedVia: 'mcp', approvedByUserId: peterId })
    const [post] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, task.id))
    expect(post!.scheduledAt.toISOString()).toBe('2026-10-13T06:45:00.000Z')
    const [log] = await db.select().from(schema.activity).where(and(eq(schema.activity.taskId, task.id), eq(schema.activity.action, 'mcp_approved')))
    expect(log!.actor).toBe('mcp')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))
    expect(notes.map(n => n.text).join('\n')).toContain(REASON)
    const again = await c.callTool({ name: 'freigeben', arguments: { code: task.code, stand: item.stand, pruefung: REASON } })
    expect(text(again)).toMatch(/freigegeben/)

    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0]!
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    expect(await trustSuggestions(db, ws, p!)).toEqual([])
    const rel = await releasedDrafts(db, ws, undefined)
    expect(rel.outgoing.find(r => r.draft.id === draft.id)?.at?.toISOString()).toBe('2026-10-13T06:45:00.000Z')
    expect(rel.self.some(r => r.draft.id === draft.id)).toBe(false)
    await stopMcpApproval(db, ws, peterId, draft.id)
    const [d2] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(d2).toMatchObject({ status: 'offen', approvedVia: null, releaseAt: null })
    const [t2] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t2!.status).toBe('entwurf_fertig')
    const [post2] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, post!.id))
    expect(post2!.status).toBe('abgebrochen')
    await expect(stopMcpApproval(db, ws, peterId, draft.id)).rejects.toThrow(/Nicht mehr zu stoppen/)
  })

  it('Selbst freigegebene Posts: geplant geht raus und lässt sich stoppen, Reddit bleibt bei mir', async () => {
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0]!
    const { task, draft } = await makeDraft({ date: '2026-10-14', time: '10:00' })
    await approveAndSchedule(db, ws, peterId, draft.id)
    const reddit = await makeDraft({ category: 'community', date: '2026-10-14' })
    await db.update(schema.tasks).set({ channel: 'Reddit' }).where(eq(schema.tasks.id, reddit.task.id))
    await approveAndSchedule(db, ws, peterId, reddit.draft.id)
    const rel = await releasedDrafts(db, ws, undefined)
    expect(rel.outgoing.find(r => r.draft.id === draft.id)?.at).toBeTruthy()
    expect([...rel.self, ...rel.soon].some(r => r.draft.id === reddit.draft.id)).toBe(true)
    await expect(stopMcpApproval(db, ws, peterId, draft.id)).rejects.toThrow(/nicht von Claude/)
    await stopRelease(db, ws, peterId, draft.id)
    const [d2] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(d2!.status).toBe('offen')
    const posts = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, task.id))
    expect(posts.every(p => p.status === 'abgebrochen')).toBe(true)
    const [log] = await db.select().from(schema.activity).where(and(eq(schema.activity.taskId, task.id), eq(schema.activity.action, 'release_stopped')))
    expect(log).toBeTruthy()
  })

  it('geplanter Termin nach der Frist gilt', async () => {
    const { draft } = await makeDraft({ date: '2026-10-15', time: '11:00' })
    const c = await client(await principal({ approve: true }))
    const ok = data(await c.callTool({ name: 'freigeben', arguments: { entwurf_id: draft.id, stand: draftStamp(draft), pruefung: REASON } }))
    expect(ok.releaseAt).toBe('2026-10-15T09:00:00.000Z')
  })

  it('Sperren: lange Striche, Projekt-Regel, Info nötig, Mail, Art nicht erlaubt, Projekt aus, toter Link', async () => {
    const c = await client(await principal({ approve: true }))
    const tryIt = async (d: typeof schema.drafts.$inferSelect, client2 = c) => client2.callTool({ name: 'freigeben', arguments: { entwurf_id: d.id, stand: draftStamp(d), pruefung: REASON } })

    const dash = await makeDraft({ body: 'Night Drive — out now https://thewanderer.example/x' })
    expect(text(await tryIt(dash.draft))).toMatch(/Lange Striche/)
    const rule = await makeDraft({ body: 'Mit Jonas am Bass: https://thewanderer.example/x' })
    expect(text(await tryIt(rule.draft))).toMatch(/Projekt-Regeln/)
    const info = await makeDraft()
    await db.insert(schema.taskNotes).values({ taskId: info.task.id, byAgent: true, text: 'Info nötig: Wann erscheint der Song?', createdAt: new Date('2026-10-13T06:20:00Z') })
    expect(text(await tryIt(info.draft))).toMatch(/Info nötig: Wann erscheint/)
    const list = data(await c.callTool({ name: 'freigaben_liste', arguments: {} }))
    expect((list.drafts as { draftId: string, infoNeeded: string[] | null }[]).find(d => d.draftId === info.draft.id)!.infoNeeded).toEqual(['Wann erscheint der Song?'])
    const mail = await makeDraft({ category: 'outreach', kind: 'mail', body: 'Hallo, kurze Frage zu eurem Blog.' })
    expect(text(await tryIt(mail.draft))).toMatch(/nur der Mensch/)
    await settings({ kinds: ['content'] })
    const soc = await makeDraft()
    expect(text(await tryIt(soc.draft))).toMatch(/nicht erlaubt/)
    await settings({ kinds: ['social'], offProjects: [projectId] })
    expect(text(await tryIt(soc.draft))).toMatch(/Projekt/)
    await settings({ offProjects: [] })
    const dead = await client(await principal({ approve: true }), { webFetch: async () => new Response(null, { status: 404 }) })
    expect(text(await tryIt(soc.draft, dead))).toMatch(/Links nicht erreichbar/)
    const [still] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, soc.draft.id))
    expect(still!.status).toBe('offen')
  })

  it('Tageslimit', async () => {
    await settings({ perDay: 1 })
    const c = await client(await principal({ approve: true }))
    const a = await makeDraft({ time: null })
    const b = await makeDraft({ time: null })
    expect((await c.callTool({ name: 'freigeben', arguments: { entwurf_id: a.draft.id, stand: draftStamp(a.draft), pruefung: REASON } })).isError).toBeFalsy()
    const r = await c.callTool({ name: 'freigeben', arguments: { entwurf_id: b.draft.id, stand: draftStamp(b.draft), pruefung: REASON } })
    expect(text(r)).toMatch(/Tageslimit/)
  })
})

describe('Mail-Antworten über MCP', () => {
  const MAIL_REASON = 'Regeln gelesen, Antwort geht nur an den Absender, Ton passt, keine Platzhalter, keine Links.'

  async function makeReply(o: { from?: string, recipient?: string, category?: 'pflege' | 'outreach', incoming?: boolean, contact?: 'warm' | 'gesperrt' } = {}) {
    seq++
    const from = o.from ?? `fan${seq}@example.org`
    const [t] = await db.insert(schema.tasks).values({ workspaceId: wsId, projectId, code: `TV-PFL-${String(seq).padStart(3, '0')}`, title: `Antwort an Fan ${seq}`, category: o.category ?? 'pflege', dueDate: '2026-10-13', dueTime: '08:00', draftKind: 'mail', status: 'entwurf_fertig' }).returning()
    const [c] = o.contact ? await db.insert(schema.contacts).values({ workspaceId: wsId, projectId, name: `Fan ${seq}`, email: from, status: o.contact }).returning() : [null]
    if (o.incoming !== false) await db.insert(schema.mails).values({ workspaceId: wsId, projectId, direction: 'in', status: 'empfangen', kind: 'reply', messageId: null, inReplyTo: `<m${seq}@example.org>`, fromAddr: from, subject: 'Frage zum Konzert', taskId: t!.id, contactId: c?.id ?? null })
    const [d] = await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'mail', body: 'Hallo, danke für deine Mail. Das Konzert beginnt um 20 Uhr. Liebe Grüße', byAgent: true, recipient: o.recipient ?? from, subject: 'Re: Frage zum Konzert' }).returning()
    return { task: t!, draft: d! }
  }

  beforeAll(async () => {
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    await db.update(schema.projects).set({ setup: { ...p!.setup, mail: { imap: { host: 'imap.example', port: 993, secure: true, user: 'tv' }, smtp: { host: 'smtp.example', port: 465, secure: true, user: 'tv' }, from: 'tv@thewanderer.example', secret: { enc: 'x', hint: 'x', setAt: '2026-10-01T00:00:00Z' } } } }).where(eq(schema.projects.id, projectId))
  })

  it('Art aus: abgelehnt, freigaben_liste nennt den Grund', async () => {
    const { draft } = await makeReply()
    const c = await client(await principal({ approve: true }))
    const list = data(await c.callTool({ name: 'freigaben_liste', arguments: {} }))
    const item = (list.drafts as { draftId: string, mcpAllowed: boolean, blockers: string[] }[]).find(d => d.draftId === draft.id)!
    expect(item.mcpAllowed).toBe(false)
    expect(item.blockers.join(' ')).toMatch(/Art "mail"/)
    const r = await c.callTool({ name: 'freigeben', arguments: { entwurf_id: draft.id, stand: draftStamp(draft), pruefung: MAIL_REASON } })
    expect(text(r)).toMatch(/nicht erlaubt/)
  })

  it('Mail-Antworten gibt MCP nie frei: nur der Mensch sendet (Klick auf Senden)', async () => {
    await settings({ kinds: ['social', 'mail'] })
    const c = await client(await principal({ approve: true }))
    const { task, draft } = await makeReply({ contact: 'warm' })
    const list = data(await c.callTool({ name: 'freigaben_liste', arguments: {} }))
    const row = (list.drafts as { draftId: string, mcpAllowed: boolean, blockers: string[] }[]).find(d => d.draftId === draft.id)!
    expect(row.mcpAllowed).toBe(false)
    expect(row.blockers.join(' ')).toMatch(/Klick eines Menschen/)
    expect(text(await c.callTool({ name: 'freigeben', arguments: { entwurf_id: draft.id, stand: draftStamp(draft), pruefung: MAIL_REASON } }))).toMatch(/Klick eines Menschen/)
    expect(await db.select().from(schema.mails).where(and(eq(schema.mails.draftId, draft.id), eq(schema.mails.direction, 'out')))).toHaveLength(0)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(d!.status).toBe('offen')
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('entwurf_fertig')
  })

  it('Sperren: Erstmail, anderer Empfänger, CC, Kaltmail-Aufgabe, gesperrter Kontakt', async () => {
    await settings({ kinds: ['mail'] })
    const c = await client(await principal({ approve: true }))
    const tryIt = async (d: typeof schema.drafts.$inferSelect) => text(await c.callTool({ name: 'freigeben', arguments: { entwurf_id: d.id, stand: draftStamp(d), pruefung: MAIL_REASON } }))
    expect(await tryIt((await makeReply({ incoming: false })).draft)).toMatch(/Keine eingegangene Mail/)
    expect(await tryIt((await makeReply({ recipient: 'jemand@anders.example' })).draft)).toMatch(/nicht der Absender/)
    expect(await tryIt((await makeReply({ from: 'cc@example.org', recipient: 'cc@example.org, chef@example.org' })).draft)).toMatch(/Nur ein Empfänger/)
    expect(await tryIt((await makeReply({ category: 'outreach' })).draft)).toMatch(/nur der Mensch/)
    expect(await tryIt((await makeReply({ contact: 'gesperrt' })).draft)).toMatch(/gesperrt/)
    const out = await db.select().from(schema.mails).where(and(eq(schema.mails.direction, 'out'), eq(schema.mails.status, 'geplant')))
    expect(out).toHaveLength(0)
  })
})

describe('Info nötig über MCP lösen', () => {
  it('Gespräch lesen, antworten, neue Fassung bleibt in den Freigaben', async () => {
    await db.update(schema.projects).set({ autonomy: { social: 'auto' } }).where(eq(schema.projects.id, projectId))
    const { task } = await makeDraft()
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: 'Info nötig: Wann erscheint der Song?', createdAt: new Date('2026-10-13T06:20:00Z') })
    const llm = async () => llmReply({ content: JSON.stringify({ type: 'revise', text: 'Danke, ich schreibe den Post mit dem 20.10. neu.' }) })
    const c = await client(await principal(), { llmFetch: llm })
    const talk = data(await c.callTool({ name: 'aufgabe_gespraech', arguments: { code: task.code } }))
    expect(talk.infoNeeded).toEqual(['Wann erscheint der Song?'])
    expect(talk.openQuestion).toBe('Wann erscheint der Song?')

    const r = data(await c.callTool({ name: 'aufgabe_antworten', arguments: { code: task.code, text: 'Der Song erscheint am 20.10.' } }))
    expect(r.revising).toBe(true)
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))
    expect(job!.payload).toMatchObject({ taskId: task.id, hold: true })
    const [log] = await db.select().from(schema.activity).where(and(eq(schema.activity.taskId, task.id), eq(schema.activity.action, 'note_added')))
    expect(log!.actor).toBe('mcp')

    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0]!
    const draftLlm = async () => llmReply({ content: JSON.stringify({ kind: 'post', body: 'Night Drive erscheint am 20.10. https://thewanderer.example/night-drive', variants: { bluesky: 'Night Drive erscheint am 20.10. https://thewanderer.example/night-drive' }, media: 'none' }) })
    await runDraftTask(db, ws, task.id, draftLlm as unknown as typeof fetch, { hold: true })
    const drafts = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    expect(drafts.find(d => d.version === 2)?.status).toBe('offen')
    expect(await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, task.id))).toHaveLength(0)
    await db.update(schema.projects).set({ autonomy: {} }).where(eq(schema.projects.id, projectId))
  })
})

describe('Prüfung nur für die Plattformen des Entwurfs', () => {
  it('keine Hinweise zu verbundenen Plattformen, die der Entwurf nicht bespielt', async () => {
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    const masto = await upsertConnection(db, wsId, { provider: 'mastodon', platform: 'mastodon', name: '@tv', handle: 'tv@mastodon.social', ext: { instance: 'https://mastodon.social' } }, { accessToken: 'x' }, { projectId })
    await db.update(schema.projects).set({ setup: { social: { accountIds: [...(p!.setup?.social?.accountIds ?? []), masto.id] } } }).where(eq(schema.projects.id, projectId))
    try {
      const { task, draft } = await makeDraft({ body: 'Night Drive is out now: https://thewanderer.example/night-drive' })
      const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId))
      const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
      const [d] = await db.update(schema.drafts).set({ platforms: ['bluesky'] }).where(eq(schema.drafts.id, draft.id)).returning()
      const r = await reviewForMcp(db, ws!, task, d!, proj!)
      expect([...r.hints, ...r.blockers].join(' | ')).not.toMatch(/Mastodon/)
      const [all] = await db.update(schema.drafts).set({ platforms: ['bluesky', 'mastodon'] }).where(eq(schema.drafts.id, draft.id)).returning()
      expect((await reviewForMcp(db, ws!, task, all!, proj!)).hints.join(' | ')).toMatch(/Mastodon/)
    }
    finally {
      await db.update(schema.projects).set({ setup: p!.setup }).where(eq(schema.projects.id, projectId))
    }
  })
})
