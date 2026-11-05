import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDraftTask } from '../../server/lib/agent'
import { listConnections, upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { checkAuthorize, exchangeCode, issueCode, OAuthError, pkceChallenge, refreshGrant, registerClient } from '../../server/lib/api/oauth'
import { apiActor, resolveBearer, type ApiPrincipal } from '../../server/lib/api/principal'
import { matchRoute, openApi, ROUTES } from '../../server/lib/api/rest'
import * as svc from '../../server/lib/api/service'
import { createApiToken, hashSecret, revokeApiToken } from '../../server/lib/api/tokens'
import { buildMcpServer } from '../../server/lib/mcp/server'
import { MCP_TOOLS } from '../../server/lib/mcp/tools'
import { resetSecretCache } from '../../server/lib/secret'

let db: Db
let close: () => Promise<void>
let wsId: string
let peterId: string
let annaId: string
const P: Record<string, string> = {}
const BASE = 'http://localhost:3210'

const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } })
const llmReply = (msg: Record<string, unknown>) => json({ model: 'mock', choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1 } })

async function principal(userId: string, scope: 'read' | 'write'): Promise<ApiPrincipal> {
  const { token } = await createApiToken(db, { userId, workspaceId: wsId, name: `t-${scope}`, scope })
  return (await resolveBearer(db, token))!
}

async function mcpClient(p: ApiPrincipal, llmFetch?: (url: string, init: RequestInit) => Promise<Response>) {
  const server = buildMcpServer({ db, actor: await apiActor(db, p), principal: p, deps: llmFetch ? { llmFetch } : {} }, BASE)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

function data(r: unknown): Record<string, unknown> {
  const c = (r as { content: { text: string }[] }).content[0]!
  return JSON.parse(c.text) as Record<string, unknown>
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  const [w] = await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning()
  wsId = w!.id
  const [peter] = await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning()
  const [anna] = await db.insert(schema.users).values({ email: 'anna@test.local', name: 'Anna' }).returning()
  peterId = peter!.id
  annaId = anna!.id
  await db.insert(schema.memberships).values([{ workspaceId: wsId, userId: peterId, role: 'owner' }, { workspaceId: wsId, userId: annaId, role: 'member' }])
  for (const [slug, code, rules] of [['tonebase', 'BIT', null], ['linkbox', 'BMX', null], ['thewanderer', 'TV', 'Never mention other identities. Max 1 post per platform per day.']] as const) {
    const [p] = await db.insert(schema.projects).values({ workspaceId: wsId, slug, name: slug, code, icon: 'music', url: `https://${slug}.example`, rules }).returning()
    P[slug] = p!.id
  }
  await db.insert(schema.projectMembers).values({ projectId: P.tonebase!, userId: annaId })
  await db.insert(schema.tasks).values([
    { workspaceId: wsId, projectId: P.tonebase!, code: 'BIT-SOC-001', title: 'Post tonebase', category: 'social', dueDate: '2026-10-14', draftKind: 'post' },
    { workspaceId: wsId, projectId: P.linkbox!, code: 'BMX-SOC-001', title: 'Post linkbox', category: 'social', dueDate: '2026-10-14', draftKind: 'post' },
  ])
})

afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('API-Tokens', () => {
  it('nur gehasht gespeichert, auflösbar, widerrufbar', async () => {
    const { id, token } = await createApiToken(db, { userId: peterId, workspaceId: wsId, name: 'Claude Code', scope: 'write' })
    expect(token).toMatch(/^amk_[\w-]{40,}$/)
    const [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id))
    expect(row!.tokenHash).toBe(hashSecret(token))
    expect(JSON.stringify(row)).not.toContain(token)
    const p = await resolveBearer(db, token)
    expect(p?.session.user.id).toBe(peterId)
    expect(p?.scope).toBe('write')
    expect(await resolveBearer(db, `${token}x`)).toBeNull()
    expect(await resolveBearer(db, 'amk_falsch')).toBeNull()
    expect(await revokeApiToken(db, annaId, id)).toBe(false)
    expect(await revokeApiToken(db, peterId, id)).toBe(true)
    expect(await resolveBearer(db, token)).toBeNull()
  })

  it('ohne Mitgliedschaft im Arbeitsbereich ungültig', async () => {
    const [u] = await db.insert(schema.users).values({ email: 'ex@test.local', name: 'Ex' }).returning()
    await db.insert(schema.memberships).values({ workspaceId: wsId, userId: u!.id, role: 'member' })
    const { token } = await createApiToken(db, { userId: u!.id, workspaceId: wsId, name: 'x', scope: 'read' })
    expect(await resolveBearer(db, token)).not.toBeNull()
    await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, u!.id), eq(schema.memberships.workspaceId, wsId)))
    expect(await resolveBearer(db, token)).toBeNull()
  })
})

describe('Rechte: nur eigene Projekte', () => {
  it('Anna sieht nur tonebase', async () => {
    const actor = await apiActor(db, await principal(annaId, 'write'))
    expect((await svc.listProjects(db, actor)).map(p => p.slug)).toEqual(['tonebase'])
    await expect(svc.projectStatus(db, actor, 'linkbox')).rejects.toMatchObject({ status: 404 })
    await expect(svc.getTask(db, actor, 'BMX-SOC-001')).rejects.toMatchObject({ status: 404 })
    await expect(svc.createTask(db, actor, { project: 'linkbox', title: 'x', category: 'social' })).rejects.toMatchObject({ status: 404 })
    const found = await svc.searchTasks(db, actor, {})
    expect(found.map(t => t.code)).toEqual(['BIT-SOC-001'])
    const week = await svc.weekPlan(db, actor, {})
    expect(week.items.some(i => i.project === 'linkbox')).toBe(false)
  })

  it('Token nur lesen: keine Änderungen, auch nicht über den Agenten-Weg', async () => {
    const actor = await apiActor(db, await principal(peterId, 'read'))
    expect((await svc.listProjects(db, actor)).length).toBe(3)
    await expect(svc.createTask(db, actor, { project: 'tonebase', title: 'x', category: 'social' })).rejects.toMatchObject({ status: 403 })
    await expect(svc.saveDraft(db, actor, 'BIT-SOC-001', { body: 'x' })).rejects.toMatchObject({ status: 403 })
    await expect(svc.talkToAgent(db, actor, { message: 'hi' })).rejects.toMatchObject({ status: 403 })
  })

  it('Projekt-Regeln kommen mit', async () => {
    const actor = await apiActor(db, await principal(peterId, 'read'))
    const st = await svc.projectStatus(db, actor, 'thewanderer')
    expect(st.project.rules).toContain('Never mention other identities')
  })

  it('REST: Schreib-Routen verlangen write, OpenAPI vollständig', () => {
    const m = matchRoute('POST', '/tasks')
    expect(m && m !== 'method' && m.route.scope).toBe('write')
    expect(matchRoute('DELETE', '/tasks')).toBe('method')
    const g = matchRoute('GET', '/projects/the%20wanderer')
    expect(g && g !== 'method' && g.params.project).toBe('the wanderer')
    expect(ROUTES.every(r => r.method === 'GET' ? r.scope === 'read' : r.scope === 'write')).toBe(true)
    const spec = openApi(BASE)
    expect(Object.keys(spec.paths)).toContain('/tasks/{code}/drafts')
    expect(JSON.stringify(spec)).not.toMatch(/publish|approve|\/send/)
  })
})

describe('OAuth mit dynamischer Registrierung', () => {
  it('Registrieren, PKCE, Token, Rotation, Wiederverwendung sperrt', async () => {
    await expect(registerClient(db, { redirect_uris: ['http://evil.example/cb'] })).rejects.toBeInstanceOf(OAuthError)
    const c = await registerClient(db, { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })
    const verifier = 'v'.repeat(50)
    const req = await checkAuthorize(db, BASE, { response_type: 'code', client_id: c.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', resource: `${BASE}/mcp` })
    expect(req.requested).toBe('write')
    await expect(checkAuthorize(db, BASE, { response_type: 'code', client_id: c.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' })).rejects.toBeInstanceOf(OAuthError)
    const code = await issueCode(db, req, annaId, wsId, 'read')
    await expect(exchangeCode(db, BASE, { code, client_id: c.client_id, redirect_uri: req.redirectUri, code_verifier: 'w'.repeat(50) })).rejects.toBeInstanceOf(OAuthError)
    const code2 = await issueCode(db, req, annaId, wsId, 'read')
    const tok = await exchangeCode(db, BASE, { code: code2, client_id: c.client_id, redirect_uri: req.redirectUri, code_verifier: verifier })
    expect(tok.scope).toBe('read')
    const p = await resolveBearer(db, tok.access_token)
    expect(p?.via).toBe('oauth')
    expect(p?.session.user.id).toBe(annaId)
    const member = async () => true
    const next = await refreshGrant(db, { refresh_token: tok.refresh_token, client_id: c.client_id }, member)
    expect(await resolveBearer(db, tok.access_token)).toBeNull()
    expect(await resolveBearer(db, next.access_token)).not.toBeNull()
    await expect(refreshGrant(db, { refresh_token: tok.refresh_token, client_id: c.client_id }, member)).rejects.toBeInstanceOf(OAuthError)
    expect(await resolveBearer(db, next.access_token)).toBeNull()
  })
})

describe('MCP', () => {
  it('Werkzeugliste je Bereich, saubere Annotations', async () => {
    const read = await mcpClient(await principal(peterId, 'read'))
    const rl = (await read.listTools()).tools
    expect(rl.length).toBe(MCP_TOOLS.filter(t => t.readOnly).length)
    expect(rl.every(t => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true)
    expect(rl.map(t => t.name)).toEqual(expect.arrayContaining(['projekte_liste', 'projekt_stand', 'wochenplan', 'freigaben_liste', 'entwurf_lesen']))
    const write = await mcpClient(await principal(peterId, 'write'))
    const wl = (await write.listTools()).tools
    const by = Object.fromEntries(wl.map(t => [t.name, t]))
    expect(Object.keys(by)).toEqual(expect.arrayContaining(['aufgabe_anlegen', 'aufgabe_verschieben', 'ziel_setzen', 'kanal_takt', 'mit_agent_reden', 'entwurf_speichern']))
    expect(by.aufgabe_anlegen!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false })
    expect(by.entwurf_verwerfen!.annotations?.destructiveHint).toBe(true)
    expect(by.webseite_lesen!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true })
    expect(wl.every(t => t.description && t.annotations?.title)).toBe(true)
    expect(wl.map(t => t.name).filter(n => /post|send|publish|approve|entwurf_freigeben/.test(n))).toEqual([])
    const denied = await read.callTool({ name: 'aufgabe_anlegen', arguments: { projekt: 'tonebase', titel: 'x', kategorie: 'social' } })
    expect(denied.isError).toBe(true)
  })

  it('Stand und Wochenplan', async () => {
    const c = await mcpClient(await principal(annaId, 'read'))
    const st = data(await c.callTool({ name: 'projekt_stand', arguments: { projekt: 'tonebase' } }))
    expect((st.week as { tasks: { code: string }[] }).tasks.map(t => t.code)).toContain('BIT-SOC-001')
    const other = await c.callTool({ name: 'projekt_stand', arguments: { projekt: 'linkbox' } })
    expect(other.isError).toBe(true)
  })

  it('kein Posten über MCP: Entwurf bleibt offen, auch bei Stufe "macht selbst" und Schalter an', async () => {
    const conn = await upsertConnection(db, wsId, { provider: 'bluesky', platform: 'bluesky', name: '@tv', handle: 'tv.bsky.social', ext: { did: 'did:plc:tv' } }, { identifier: 'tv.bsky.social', password: 'app-pass' }, { projectId: P.thewanderer! })
    const [w] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId))
    await db.update(schema.workspaces).set({ settings: { ...w!.settings, publishLive: true } }).where(eq(schema.workspaces.id, wsId))
    await db.update(schema.projects).set({ autonomy: { social: 'auto' }, setup: { social: { accountIds: [conn.id] } } }).where(eq(schema.projects.id, P.thewanderer!))
    expect(listConnections((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0]!)).toHaveLength(1)

    const c = await mcpClient(await principal(peterId, 'write'))
    const created = data(await c.callTool({ name: 'aufgabe_anlegen', arguments: { projekt: 'thewanderer', titel: 'Post zum neuen Song', kategorie: 'social', datum: '2026-10-15', uhrzeit: '11:00', beschreibung: 'Neuer Song "Night Drive"' } }))
    const code = String(created.code)
    expect(created.rules).toContain('Never mention other identities')
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.code, code))
    expect(task!.origin).toBe('api')

    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0]!
    const llm = async () => llmReply({ content: JSON.stringify({ kind: 'post', body: 'Night Drive is out \u2014 listen now', variants: { bluesky: 'Night Drive is out' }, media: 'none' }) })
    await runDraftTask(db, ws, task!.id, llm as unknown as typeof fetch)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task!.id))
    expect(d!.status).toBe('offen')
    expect(await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, task!.id))).toHaveLength(0)
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task!.id))
    expect(notes.map(n => n.text).join(' ')).toMatch(/API\/MCP/)

    const saved = data(await c.callTool({ name: 'entwurf_speichern', arguments: { code, text: 'Night Drive \u2014 out now', fassungen: { bluesky: 'Night Drive out now' } } }))
    expect(saved.status).toBe('offen')
    expect(saved.body).toBe('Night Drive - out now')
    expect(saved.platforms).toEqual(['bluesky'])
    const more = data(await c.callTool({ name: 'entwurf_speichern', arguments: { code, text: 'Night Drive out now', fassungen: { x: 'Night Drive', Facebook: 'Night Drive is out now' } } }))
    expect(more.platforms).toEqual(['x', 'facebook'])
    const set = data(await c.callTool({ name: 'entwurf_speichern', arguments: { code, text: 'Night Drive out now', plattformen: ['x', 'instagram', 'quatsch'] } }))
    expect(set.platforms).toEqual(['x', 'instagram'])
    expect(Object.keys(set.variants as object)).toEqual(['x', 'facebook'])
    expect(await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, task!.id))).toHaveLength(0)
    expect(await db.select().from(schema.mails)).toHaveLength(0)
    const jobs = await db.select().from(schema.jobs)
    expect(jobs.filter(j => /publish|send/.test(j.type))).toHaveLength(0)
  })

  it('mit_agent_reden: Agent darf über MCP keine Freigabe-Stufe lockern', async () => {
    let step = 0
    const llm = async () => {
      step++
      if (step === 1) return llmReply({ content: '', tool_calls: [{ id: 'c1', function: { name: 'set_autonomy', arguments: JSON.stringify({ project: 'linkbox', kind: 'social', level: 'auto' }) } }] })
      return llmReply({ content: 'Das geht nur in Aimarage selbst.' })
    }
    const c = await mcpClient(await principal(peterId, 'write'), llm)
    const r = data(await c.callTool({ name: 'mit_agent_reden', arguments: { nachricht: 'Stell linkbox Social auf selbst', projekt: 'linkbox' } }))
    expect(r.reply).toContain('Aimarage')
    expect(r.toolsUsed).toEqual(['set_autonomy'])
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, P.linkbox!))
    expect(p!.autonomy.social).toBeUndefined()
  })
})

describe('MCP aufgabe_ziel', () => {
  it('setzt Ziel-Link und Ort, offene Entwürfe bekommen den Link, nur mit Schreibrecht', async () => {
    const [t] = await db.insert(schema.tasks).values({ workspaceId: wsId, projectId: P.tonebase!, code: 'BIT-COM-901', title: 'Reddit: Konzept vorstellen', category: 'community', dueDate: '2026-10-20', draftKind: 'post', status: 'entwurf_fertig' }).returning()
    await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'post', body: 'Hallo r/aiMusic', targetUrl: 'https://www.reddit.com/r/aiMusic/comments/old/x/' })
    const c = await mcpClient(await principal(peterId, 'write'))
    const r = data(await c.callTool({ name: 'aufgabe_ziel', arguments: { code: 'BIT-COM-901', ziel_url: 'https://www.reddit.com/r/aiMusic/', ort: 'r/aiMusic' } }))
    expect(r.targetUrl).toBe('https://www.reddit.com/r/aiMusic/')
    expect(r.channel).toBe('r/aiMusic')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t!.id))
    expect(d!.targetUrl).toBe('https://www.reddit.com/r/aiMusic/')
    const bad = await c.callTool({ name: 'aufgabe_ziel', arguments: { code: 'BIT-COM-901', ziel_url: 'javascript:alert(1)' } }) as { isError?: boolean }
    expect(bad.isError).toBe(true)
    const ro = await mcpClient(await principal(peterId, 'read'))
    const names = (await ro.listTools()).tools.map(x => x.name)
    expect(names).not.toContain('aufgabe_ziel')
  })
})

describe('MCP serie_beenden', () => {
  it('beendet die Serie per Aufgaben-Code, ohne Projektzugriff nicht', async () => {
    const [rec] = await db.insert(schema.recurrences).values({ workspaceId: wsId, projectId: P.linkbox!, rule: 'weekly:WE', title: 'Serie linkbox', category: 'social' }).returning()
    await db.insert(schema.tasks).values({ workspaceId: wsId, projectId: P.linkbox!, recurrenceId: rec!.id, occurrenceKey: '2026-10-21', code: 'BMX-SOC-090', title: 'Serie linkbox', category: 'social', dueDate: '2026-10-21' })
    const anna = await mcpClient(await principal(annaId, 'write'))
    expect((await anna.callTool({ name: 'serie_beenden', arguments: { code: 'BMX-SOC-090' } })).isError).toBe(true)
    const peter = await mcpClient(await principal(peterId, 'write'))
    const r = data(await peter.callTool({ name: 'serie_beenden', arguments: { code: 'BMX-SOC-090' } }))
    expect(r.verworfen).toEqual(['BMX-SOC-090'])
    const [row] = await db.select().from(schema.recurrences).where(eq(schema.recurrences.id, rec!.id))
    expect(row!.active).toBe(false)
  })
})
