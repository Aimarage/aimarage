import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { apiActor, narrowAccess, resolveBearer, type ApiPrincipal } from '../../server/lib/api/principal'
import { createApiToken, listApiTokens, revokeApiToken, updateApiToken } from '../../server/lib/api/tokens'
import { alertDenied, DENIED_ALERT, keyOf, listCalls, logCall, pruneCalls, shortIp, summarizeArgs } from '../../server/lib/api/call-log'
import { deadKey } from '../../server/lib/api/http'
import { warnExpiringTokens } from '../../server/lib/api/token-expiry'
import { permOfRoute, ROUTES } from '../../server/lib/api/rest'
import { buildMcpServer, instructionsFor, logHiddenCalls } from '../../server/lib/mcp/server'
import { MCP_TOOLS, permOfTool } from '../../server/lib/mcp/tools'
import { chatToolAllowed } from '../../server/lib/chat'
import { reviewForMcp } from '../../server/lib/mcp-approve'
import { resetSecretCache } from '../../server/lib/secret'
import { cleanPerms, legacyPerms, scopeOfPerms } from '../../shared/utils/api-perms'
import { DATA_NOTE, privateDataProblems, redactPrivate, scrubSecrets } from '../../shared/utils/private-data'

let db: Db
let close: () => Promise<void>
let wsId: string
let peterId: string
const P: Record<string, string> = {}
const BASE = 'http://localhost:3210'

async function principal(input: { perms?: string[], projects?: string[] | null, days?: number } = {}): Promise<ApiPrincipal> {
  const { token } = await createApiToken(db, { userId: peterId, workspaceId: wsId, name: 'Claude Code', perms: (input.perms ?? ['read']) as never, projectIds: input.projects ?? null, days: input.days })
  return (await resolveBearer(db, token))!
}

async function client(p: ApiPrincipal, deps: Record<string, unknown> = {}) {
  const server = buildMcpServer({ db, actor: await apiActor(db, p), principal: p, deps, client: 'test-ua', ip: '203.0.113.77' }, BASE)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(a), c.connect(b)])
  return c
}

type Res = { isError?: boolean, content: { text: string }[] }
const data = (r: unknown) => JSON.parse((r as Res).content[0]!.text) as Record<string, unknown>

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  const [w] = await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning()
  wsId = w!.id
  const [peter] = await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning()
  peterId = peter!.id
  await db.insert(schema.memberships).values({ workspaceId: wsId, userId: peterId, role: 'owner' })
  for (const [slug, code] of [['tonebase', 'BIT'], ['linkbox', 'BMX']] as const) {
    const [p] = await db.insert(schema.projects).values({ workspaceId: wsId, slug, name: slug, code, icon: 'music', url: `https://${slug}.example` }).returning()
    P[slug] = p!.id
  }
  const [t] = await db.insert(schema.tasks).values({ workspaceId: wsId, projectId: P.tonebase!, code: 'BIT-MAI-001', title: 'Antwort an Lena', category: 'pflege', dueDate: '2026-10-14', draftKind: 'mail', description: 'Eingegangene Mail von lena.privat@gmail.com: Hallo!' }).returning()
  await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'mail', body: 'Hallo Lena, danke!', recipient: 'lena.privat@gmail.com', subject: 'Re: Hallo', byAgent: true })
  await db.insert(schema.tasks).values({ workspaceId: wsId, projectId: P.linkbox!, code: 'BMX-SOC-001', title: 'Post linkbox', category: 'social', dueDate: '2026-10-14', draftKind: 'post' })
})

afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Rechte je Schlüssel', () => {
  it('übernimmt alte Schlüssel mit ihren bisherigen Rechten', () => {
    expect(legacyPerms('read')).toEqual(['read', 'private'])
    expect(legacyPerms('write')).toEqual(['read', 'private', 'draft', 'strategy', 'agent'])
    expect(legacyPerms('write', true)).toContain('approve')
    expect(cleanPerms(['approve', 'quatsch'])).toEqual(['read', 'draft', 'approve'])
    expect(scopeOfPerms(['read', 'private'])).toBe('read')
  })

  it('neuer Schlüssel: 90 Tage gültig, nur gehasht, alte Aufrufe mit scope bleiben gleich', async () => {
    const { id, token, expiresAt } = await createApiToken(db, { userId: peterId, workspaceId: wsId, name: 'Alt', scope: 'write', canApprove: true })
    expect(new Date(expiresAt).getTime() - new Date('2026-10-13T06:15:00Z').getTime()).toBe(90 * 86_400_000)
    const [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id))
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row!.perms).toEqual(['read', 'private', 'draft', 'strategy', 'agent', 'approve'])
    const p = (await resolveBearer(db, token))!
    expect(p.canApprove).toBe(true)
    expect(p.scope).toBe('write')
  })

  it('abgelaufene Schlüssel gelten nicht mehr, Verlängern macht sie wieder gültig', async () => {
    const { id, token } = await createApiToken(db, { userId: peterId, workspaceId: wsId, name: 'Kurz', perms: ['read'], days: 30 })
    await db.update(schema.apiTokens).set({ expiresAt: new Date('2026-10-01T00:00:00Z') }).where(eq(schema.apiTokens.id, id))
    expect(await resolveBearer(db, token)).toBeNull()
    expect((await listApiTokens(db, peterId, wsId)).some(t => t.id === id)).toBe(false)
    await db.update(schema.apiTokens).set({ expiresAt: new Date('2026-10-20T00:00:00Z') }).where(eq(schema.apiTokens.id, id))
    const t = await updateApiToken(db, peterId, id, { extendDays: 90 })
    expect(t!.expiresAt!.slice(0, 10)).toBe('2027-01-11')
    expect(t!.reviewNeeded).toBe(false)
  })

  it('Werkzeuge je Recht: nur lesen bietet keine Änderungen, Entwürfe ohne Strategie', async () => {
    const read = await client(await principal({ perms: ['read'] }))
    const names = (await read.listTools()).tools.map(t => t.name)
    expect(names).toContain('aufgabe_lesen')
    expect(names).not.toContain('entwurf_speichern')
    expect(names).not.toContain('unterlagen_lesen')
    expect(names).not.toContain('freigeben')
    const draft = await client(await principal({ perms: ['read', 'draft'] }))
    const d = (await draft.listTools()).tools.map(t => t.name)
    expect(d).toContain('entwurf_speichern')
    expect(d).not.toContain('ziel_setzen')
    expect(d).not.toContain('mit_agent_reden')
    expect(d).not.toContain('strategie_freigeben')
    expect(MCP_TOOLS.filter(t => !t.readOnly).every(t => permOfTool(t) !== 'read')).toBe(true)
    expect(ROUTES.filter(r => r.scope === 'write').every(r => permOfRoute(r) !== 'read')).toBe(true)
    expect(permOfRoute({ method: 'POST', path: '/chat', scope: 'write' })).toBe('agent')
  })

  it('Projekte je Schlüssel: auch Inhaber sehen nur die eingestellten', async () => {
    expect(narrowAccess({ all: true, ids: [] }, [P.tonebase!])).toEqual({ all: false, ids: [P.tonebase!] })
    expect(narrowAccess({ all: false, ids: [P.linkbox!] }, [P.tonebase!])).toEqual({ all: false, ids: [] })
    const c = await client(await principal({ perms: ['read', 'draft'], projects: [P.tonebase!] }))
    const list = data(await c.callTool({ name: 'projekte_liste', arguments: {} })) as unknown as { slug: string }[]
    expect(list.map(p => p.slug)).toEqual(['tonebase'])
    expect(((await c.callTool({ name: 'aufgabe_lesen', arguments: { code: 'BMX-SOC-001' } })) as Res).isError).toBe(true)
  })

  it('Agent über MCP darf nur, was der Schlüssel darf', () => {
    expect(chatToolAllowed({ via: 'api', perms: ['read', 'agent'] }, 'set_goal')).toBe(false)
    expect(chatToolAllowed({ via: 'api', perms: ['read', 'agent'] }, 'approve_strategy')).toBe(false)
    expect(chatToolAllowed({ via: 'api', perms: ['read', 'agent'] }, 'get_overview')).toBe(true)
    expect(chatToolAllowed({ via: 'api', perms: ['read', 'agent', 'draft'] }, 'create_task')).toBe(true)
    expect(chatToolAllowed({ via: 'api', perms: ['read', 'agent'] }, 'read_documents')).toBe(false)
    expect(chatToolAllowed({ via: 'api', perms: ['read', 'private', 'draft', 'strategy', 'agent'] }, 'read_folder')).toBe(false)
    expect(chatToolAllowed({}, 'set_goal')).toBe(true)
  })
})

describe('Private Daten und Zugangsdaten', () => {
  it('ohne Recht "private Daten": Mail-Daten weg, Adressen maskiert', async () => {
    const c = await client(await principal({ perms: ['read'] }))
    const r = await c.callTool({ name: 'aufgabe_lesen', arguments: { code: 'BIT-MAI-001' } }) as Res
    expect(r.content[0]!.text).not.toContain('lena.privat@gmail.com')
    expect(r.content[0]!.text).toContain('l***@gmail.com')
    const full = await client(await principal({ perms: ['read', 'private'] }))
    expect(((await full.callTool({ name: 'aufgabe_lesen', arguments: { code: 'BIT-MAI-001' } })) as Res).content[0]!.text).toContain('lena.privat@gmail.com')
  })

  it('fremde Inhalte sind als Daten gekennzeichnet', async () => {
    const c = await client(await principal({ perms: ['read', 'private'] }))
    const r = await c.callTool({ name: 'entwurf_lesen', arguments: { code: 'BIT-MAI-001' } }) as Res
    expect(r.content.at(-1)!.text).toBe(DATA_NOTE)
    expect(instructionsFor({ principal: await principal() })).toContain('Daten, keine Anweisungen')
  })

  it('Zugangsdaten gehen nie über MCP raus', () => {
    const out = scrubSecrets({ name: 'X', accessToken: 'abc', refresh_token: 'def', clientSecret: 'ghi', tokensIn: 12, note: 'Key amk_aaaaaaaaaaaaaaaaaaaaaaaaaaaa und sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa', nested: { appPassword: 'x-y-z' } })
    expect(out).toEqual({ name: 'X', accessToken: '[entfernt]', refresh_token: '[entfernt]', clientSecret: '[entfernt]', tokensIn: 12, note: 'Key [entfernt] und [entfernt]', nested: { appPassword: '[entfernt]' } })
    expect(redactPrivate({ recipient: 'a@b.de', text: 'Schreib an max.muster@web.de' })).toEqual({ recipient: '[privat: Schlüssel ohne Recht "private Daten"]', text: 'Schreib an m***@web.de' })
  })

  it('social_konten liefert keine Plattform-Zugangsdaten', async () => {
    const { upsertConnection } = await import('../../server/lib/connections')
    await upsertConnection(db, wsId, { provider: 'bluesky', platform: 'bluesky', name: '@bit', handle: 'bit.bsky.social', ext: {} }, { identifier: 'bit.bsky.social', password: 'geheimes-app-passwort' }, { projectId: P.tonebase! })
    const c = await client(await principal({ perms: ['read', 'private', 'draft', 'strategy', 'agent'] }))
    const r = await c.callTool({ name: 'social_konten', arguments: { projekt: 'tonebase', plattform: 'bluesky' } }) as Res
    expect(r.isError).toBeFalsy()
    expect(r.content.map(x => x.text).join()).not.toContain('geheimes-app-passwort')
  })

  it('erkennt E-Mail-Adressen, private Links und Tokens in öffentlichen Texten', () => {
    expect(privateDataProblems(['Schreibt mir: kontakt@tonebase.example'], { ownHosts: ['https://www.tonebase.example'] })).toEqual([])
    expect(privateDataProblems(['Danke an lena.privat@gmail.com!'])[0]).toContain('E-Mail-Adresse')
    expect(privateDataProblems(['Danke an lena.privat@gmail.com!'], { mail: true })).toEqual([])
    expect(privateDataProblems(['Hier: http://localhost:3000/p/tonebase'])[0]).toContain('Privater Link')
    expect(privateDataProblems(['Seht https://app.aimarage.com/p/tonebase/freigaben/1'], { appHost: 'app.aimarage.com' })[0]).toContain('Privater Link')
    expect(privateDataProblems(['Jetzt anmelden: https://app.aimarage.com/registrieren'], { appHost: 'app.aimarage.com' })).toEqual([])
    expect(privateDataProblems(['Doku https://docs.google.com/document/d/abc/edit'])[0]).toContain('Privater Link')
    expect(privateDataProblems(['Download https://cdn.example.com/f.zip?X-Amz-Signature=abcdef1234'])[0]).toContain('Privater Link')
    expect(privateDataProblems(['token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])[0]).toContain('Zugangsdaten')
    expect(privateDataProblems(['Neuer Song! https://tonebase.example/night-drive?utm_source=bluesky #synthwave'], { ownHosts: ['tonebase.example'] })).toEqual([])
  })

  it('Fediverse-Handles sind keine E-Mail-Adressen', () => {
    expect(privateDataProblems(['Danke an @SomeUser1@dice.camp und @lena@mastodon.social!'])).toEqual([])
    expect(privateDataProblems(['Schreib an someone@dice.camp'])[0]).toContain('E-Mail-Adresse')
  })

  it('Zugangsdaten nur bei echten Werten, nicht bei bloßen Wörtern', () => {
    expect(privateDataProblems(['Browser sign-in with OAuth 2.1, no API key, changes only if you enable "Make changes".'])).toEqual([])
    expect(privateDataProblems(['API key: not needed. Password: none required. Secret: good coffee'])).toEqual([])
    expect(privateDataProblems(['Passwort: xyz'])[0]).toContain('Zugangsdaten')
    expect(privateDataProblems(['api_key=abcdef123456'])[0]).toContain('Zugangsdaten')
    expect(privateDataProblems(['token: 9f8a7b6c5d4e3f2a'])[0]).toContain('Zugangsdaten')
  })

  it('Freigabe über MCP und KI-Prüfer sperrt Entwürfe mit privaten Daten', async () => {
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId))
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, P.tonebase!))
    const [t] = await db.insert(schema.tasks).values({ workspaceId: wsId, projectId: P.tonebase!, code: 'BIT-SOC-077', title: 'Post', category: 'social', dueDate: '2026-10-14', draftKind: 'post', status: 'entwurf_fertig' }).returning()
    const [d] = await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'post', body: 'Danke an lena.privat@gmail.com für das Feedback zu Night Drive!', byAgent: true }).returning()
    const r = await reviewForMcp(db, { ...ws!, settings: { ...ws!.settings, mcpApprove: { enabled: true } } }, t!, d!, p!, { via: 'reviewer', kinds: ['social'] })
    expect(r.allowed).toBe(false)
    expect(r.blockers.join()).toContain('E-Mail-Adresse')
  })
})

describe('Protokoll und Grenzen', () => {
  it('jeder Aufruf steht im Protokoll, ohne Inhalte', async () => {
    const p = await principal({ perms: ['read', 'private', 'draft'] })
    const c = await client(p)
    await c.callTool({ name: 'entwurf_speichern', arguments: { code: 'BIT-MAI-001', text: 'Geheimer Inhalt der Antwort', empfaenger: 'lena.privat@gmail.com' } })
    await c.callTool({ name: 'aufgabe_lesen', arguments: { code: 'BIT-SOC-999' } })
    const calls = await listCalls(db, { workspaceId: wsId, tokenId: p.tokenId })
    const save = calls.find(x => x.tool === 'entwurf_speichern')!
    expect(save).toMatchObject({ ok: true, project: 'tonebase', key: 'Claude Code', client: 'test-ua', ip: '203.0.113.0', args: { code: 'BIT-MAI-001', text: '27 Zeichen', empfaenger: '21 Zeichen' } })
    expect(save.bytes).toBeGreaterThan(100)
    expect(JSON.stringify(calls)).not.toContain('Geheimer')
    expect(JSON.stringify(calls)).not.toContain('lena.privat')
    expect(calls.find(x => x.tool === 'aufgabe_lesen')).toMatchObject({ ok: false, error: expect.stringContaining('nicht gefunden') })
  })

  it('Kurzfassung und gekürzte IP', () => {
    expect(summarizeArgs({ projekt: 'tonebase', url: 'https://reddit.com/r/x/comments/1', nachricht: 'Hallo du', fassungen: { a: '1', b: '2' }, tracks: ['a'] })).toEqual({ projekt: 'tonebase', url: 'URL reddit.com', nachricht: '8 Zeichen', fassungen: '2 Felder', tracks: '1 Einträge' })
    expect(shortIp('2001:db8:85a3:1:2:3:4:5')).toBe('2001:db8:85a3::')
    expect(shortIp('::ffff:198.51.100.23')).toBe('198.51.100.0')
  })

  it('Protokoll wird nach 90 Tagen gelöscht', async () => {
    const p = await principal()
    await db.insert(schema.mcpCalls).values({ workspaceId: wsId, userId: peterId, tokenId: p.tokenId, keyLabel: 'alt', tool: 'projekte_liste', ok: true, createdAt: new Date('2026-07-01T00:00:00Z') })
    expect(await pruneCalls(db)).toBe(1)
    expect((await listCalls(db, { workspaceId: wsId, tokenId: p.tokenId })).length).toBe(0)
  })

  it('Grenze je Schlüssel und Werkzeug', async () => {
    const c = await client(await principal({ perms: ['read', 'strategy'] }))
    const res: Res[] = []
    for (let i = 0; i < 4; i++) res.push(await c.callTool({ name: 'strategie_neu_denken', arguments: { projekt: 'tonebase' } }) as Res)
    expect(res[3]!.isError).toBe(true)
    expect(res[3]!.content[0]!.text).toContain('Grenze erreicht')
    expect(res[0]!.content[0]!.text).not.toContain('Grenze erreicht')
  })

  it('Warnung vor dem Ablauf: einmal je Schlüssel, Hinweis auch für Claude', async () => {
    const p = await principal({ perms: ['read'], days: 30 })
    await db.update(schema.apiTokens).set({ expiresAt: new Date('2026-10-18T00:00:00Z') }).where(eq(schema.apiTokens.id, p.tokenId!))
    expect(await warnExpiringTokens(db)).toBe(1)
    expect(await warnExpiringTokens(db)).toBe(0)
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.kind, 'api_token_expiring'))
    expect(n.length).toBe(1)
    expect(instructionsFor({ principal: { ...p, expiresAt: new Date('2026-10-18T00:00:00Z') } }, new Date('2026-10-13T06:15:00Z'))).toContain('läuft in 5 Tagen ab')
  })

  it('abgelehnte Aufrufe stehen als abgelehnt mit Grund im Protokoll', async () => {
    const p = await principal({ perms: ['read'] })
    const ctx = { db, actor: await apiActor(db, p), principal: p, deps: {}, client: 'test-ua', ip: '203.0.113.5' }
    expect(await logHiddenCalls(ctx, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ziel_setzen', arguments: { projekt: 'tonebase', name: 'Geheim' } } }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'projekte_liste' } }, { method: 'tools/call', params: { name: 'gibts_nicht' } }])).toBe(2)
    const calls = await listCalls(db, { workspaceId: wsId, tokenId: p.tokenId })
    expect(calls.find(c => c.tool === 'ziel_setzen')).toMatchObject({ ok: false, denied: true, project: 'tonebase', error: expect.stringContaining('"strategy" fehlt'), args: { projekt: 'tonebase', name: '6 Zeichen' } })
    expect(calls.find(c => c.tool === 'gibts_nicht')).toMatchObject({ denied: true, error: 'Unbekanntes Werkzeug' })
  })

  it('Grenze erreicht zählt als abgelehnt, Fehler im Werkzeug nicht', async () => {
    const p = await principal({ perms: ['read', 'strategy'] })
    const c = await client(p)
    for (let i = 0; i < 4; i++) await c.callTool({ name: 'strategie_neu_denken', arguments: { projekt: 'tonebase' } })
    await c.callTool({ name: 'aufgabe_lesen', arguments: { code: 'BIT-SOC-998' } })
    const calls = await listCalls(db, { workspaceId: wsId, tokenId: p.tokenId })
    expect(calls.filter(x => x.denied).map(x => x.error)).toEqual([expect.stringContaining('Grenze erreicht')])
    expect(calls.find(x => x.tool === 'aufgabe_lesen')).toMatchObject({ ok: false, denied: false })
  })

  it('abgelaufene und widerrufene Schlüssel werden ihrem Arbeitsbereich zugeordnet', async () => {
    const a = await createApiToken(db, { userId: peterId, workspaceId: wsId, name: 'Weg', perms: ['read'] })
    await revokeApiToken(db, peterId, a.id)
    expect(await deadKey(db, a.token)).toMatchObject({ reason: 'Schlüssel widerrufen', key: { workspaceId: wsId, tokenId: a.id } })
    const b = await createApiToken(db, { userId: peterId, workspaceId: wsId, name: 'Alt', perms: ['read'] })
    await db.update(schema.apiTokens).set({ expiresAt: new Date('2026-10-01T00:00:00Z') }).where(eq(schema.apiTokens.id, b.id))
    expect((await deadKey(db, b.token))?.reason).toBe('Schlüssel abgelaufen')
    expect(await deadKey(db, 'amk_unbekannt')).toBeNull()
  })

  it('gehäufte Ablehnungen: einmal am Tag Mail an die Person', async () => {
    const p = await principal({ perms: ['read'] })
    for (let i = 0; i < DENIED_ALERT - 1; i++) await logCall(db, p, { via: 'mcp', tool: 'freigeben', ok: false, denied: true, error: 'Recht fehlt' })
    expect((await db.select().from(schema.notifications).where(eq(schema.notifications.kind, 'api_denied'))).length).toBe(0)
    await logCall(db, p, { via: 'mcp', tool: 'freigeben', ok: false, denied: true, error: 'Recht fehlt' })
    await logCall(db, p, { via: 'mcp', tool: 'freigeben', ok: false, denied: true, error: 'Recht fehlt' })
    expect((await db.select().from(schema.notifications).where(eq(schema.notifications.kind, 'api_denied'))).length).toBe(1)
    expect(await alertDenied(db, keyOf(p))).toBe(false)
  })
})
