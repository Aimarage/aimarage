import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runOnboardProject } from '../../server/lib/agent'
import { createSession } from '../../server/lib/auth'
import { PAUSED_REPLY, runTurn, type ChatActor } from '../../server/lib/chat'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { claimJob, enqueueJob } from '../../server/lib/jobs'
import { assertAccountLimit, assertClientLinks, assertStorage, mcpAllowed, resetLimitCache } from '../../server/lib/limits'
import { resetSecretCache } from '../../server/lib/secret'

// Kostenlose Vorschau ohne Tarif: einmal Projekt + Analyse mit KI-Deckel, danach nur Teaser, alles andere pausiert.

const ROOT = resolve(__dirname, '../..')
const g = globalThis as Record<string, unknown>
let db: Db
let close: () => Promise<void>
let web: (req: Request) => Promise<Response>
let ipN = 0

interface Ws { ws: typeof schema.workspaces.$inferSelect, user: string, cookie: string }

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(f => join(dir, f)).filter(f => f.endsWith('.ts'))
}

function freshIp(): string {
  return `10.7.${Math.floor(++ipN / 250)}.${ipN % 250}`
}

async function seed(tag: string, opts: { paused?: boolean, userId?: string } = {}): Promise<Ws> {
  const [w] = await db.insert(schema.workspaces).values({
    name: `WS ${tag}`,
    pausedAt: opts.paused === false ? null : new Date(),
    settings: { llm: { provider: 'ollama', model: 'mock' } },
  }).returning()
  let user = opts.userId
  if (!user) {
    const [u] = await db.insert(schema.users).values({ email: `${tag}@vorschau.at`, name: `User ${tag}` }).returning()
    user = u!.id
  }
  await db.insert(schema.memberships).values({ workspaceId: w!.id, userId: user, role: 'owner' })
  return { ws: w!, user, cookie: await createSession(db, user, w!.id) }
}

async function reload(w: Ws): Promise<Ws> {
  const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w.ws.id))
  w.ws = row!
  return w
}

async function call(method: string, path: string, w: Ws, body?: unknown, ip = freshIp()): Promise<{ status: number, json: Record<string, any> }> {
  const headers: Record<string, string> = { 'cookie': `ma_session=${w.cookie}`, 'x-forwarded-for': ip }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await web(new Request(`http://localhost:3210${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  let json: Record<string, any> = {}
  try {
    json = JSON.parse(text)
  }
  catch {}
  return { status: res.status, json }
}

const start = (w: Ws, ip?: string) => call('POST', '/api/onboarding', w, { url: 'firma.at', description: 'Software für Tischler' }, ip)

function llmFetch(content: string) {
  const state = { calls: 0 }
  const fn = async () => {
    state.calls++
    return new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }), { status: 200 })
  }
  return { fn: fn as unknown as typeof fetch, state }
}

const webFetch = (async () => new Response('<html><head><title>Firma</title></head><body><h1>Tischler-Software</h1><p>Planung für Tischlereien.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch

beforeAll(async () => {
  process.env.APP_SECRET = 'test-secret-preview'
  process.env.TRUST_PROXY = 'true'
  process.env.LLM_PRICE_IN_EUR = '1000'
  process.env.LLM_PRICE_OUT_EUR = '1000'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  g.__maDb = Promise.resolve({ db, close: async () => {} })
  Object.assign(g, h3)
  for (const f of walk(join(ROOT, 'shared/utils'))) Object.assign(g, await import(f))
  for (const f of walk(join(ROOT, 'server/utils'))) Object.assign(g, await import(f))
  const app = h3.createApp()
  const router = h3.createRouter()
  const routes: [string, string, h3.RouterMethod][] = [
    ['server/api/onboarding/index.post.ts', '/api/onboarding', 'post'],
    ['server/api/onboarding/[id].get.ts', '/api/onboarding/:id', 'get'],
    ['server/api/strategies/[id].get.ts', '/api/strategies/:id', 'get'],
    ['server/api/strategy.get.ts', '/api/strategy', 'get'],
    ['server/api/projects/index.post.ts', '/api/projects', 'post'],
  ]
  for (const [file, path, method] of routes) router.use(path, (await import(join(ROOT, file))).default, method)
  app.use(router)
  web = h3.toWebHandler(app)
}, 120_000)

afterEach(async () => {
  await db.delete(schema.jobs)
  resetLimitCache()
})

afterAll(async () => {
  for (const k of ['APP_SECRET', 'TRUST_PROXY', 'LLM_PRICE_IN_EUR', 'LLM_PRICE_OUT_EUR']) delete process.env[k]
  g.__maDb = undefined
  resetSecretCache()
  await close()
})

describe('Vorschau ohne Tarif', () => {
  let A: Ws
  let projectId: string

  it('einmal möglich: Projekt, Flag previewUsedAt, Vorschau-Job läuft trotz Pause', async () => {
    A = await seed('anna')
    const res = await start(A)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.preview).toBe(true)
    projectId = res.json.id
    await reload(A)
    expect(A.ws.previewUsedAt).not.toBeNull()
    expect(A.ws.pausedAt).not.toBeNull()
    await enqueueJob(db, 'draft_tasks', { workspaceId: A.ws.id })
    const job = await claimJob(db, 't')
    expect(job).toMatchObject({ type: 'onboard_project', payload: { projectId, preview: true } })
    expect(await claimJob(db, 't')).toBeNull()
  })

  it('zweite Vorschau im selben Workspace gesperrt (402 trial), auch kein weiteres Projekt', async () => {
    const res = await start(A)
    expect(res.status).toBe(402)
    expect(res.json.data).toMatchObject({ code: 'limit', kind: 'trial' })
    const p = await call('POST', '/api/projects', A, { name: 'Zweites' })
    expect(p.status).toBe(402)
    expect(p.json.data?.kind).toBe('trial')
  })

  it('gleiche E-Mail in einem anderen Workspace: keine zweite Vorschau', async () => {
    const A2 = await seed('anna-zwei', { userId: A.user })
    const res = await start(A2)
    expect(res.status).toBe(402)
    expect(res.json.data?.kind).toBe('trial')
    await reload(A2)
    expect(A2.ws.previewUsedAt).toBeNull()
    expect(await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, A2.ws.id))).toHaveLength(0)
  })

  it('höchstens 3 Vorschauen je IP und Tag', async () => {
    const ip = '10.99.0.1'
    for (const tag of ['ip1', 'ip2', 'ip3']) expect((await start(await seed(tag), ip)).status).toBe(200)
    const res = await start(await seed('ip4'), ip)
    expect(res.status).toBe(429)
  })

  it('KI-Deckel greift: höchstens ein teurer Aufruf, Vorschlag trotzdem da, kein Budget-Hinweis', async () => {
    await reload(A)
    const f = llmFetch(JSON.stringify({ positioning: 'Planung für Tischler', audiences: ['Tischlereien'], competitors: [], communities: [], keywords: ['tischler software'] }))
    const out = await runOnboardProject(db, A.ws, projectId, { preview: true, llmFetch: f.fn, webFetch })
    expect(out.status).toBe('skipped')
    expect(f.state.calls).toBe(1)
    const [run] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.workspaceId, A.ws.id), eq(schema.agentRuns.job, 'onboard_project')))
    expect(run!.costEur).toBeCloseTo(2, 5)
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    expect(p!.setup.progress?.done).toBe(true)
    expect(p!.setup.preview?.posts).toEqual([])
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.workspaceId, A.ws.id))).toHaveLength(0)
  })

  it('Vorschau-Analyse ohne Vorschau-Flag läuft im pausierten Workspace nicht', async () => {
    const f = llmFetch('{}')
    const out = await runOnboardProject(db, A.ws, projectId, { llmFetch: f.fn, webFetch })
    expect(out.status).toBe('skipped')
    expect(f.state.calls).toBe(0)
  })

  it('nur Teaser: Onboarding-Status liefert Teaser ohne Vorschlags-ID, volle Strategie 402', async () => {
    const res = await call('GET', `/api/onboarding/${projectId}`, A)
    expect(res.status).toBe(200)
    expect(res.json.proposalId).toBeNull()
    expect(res.json.teaser.channels.length).toBeGreaterThan(0)
    expect(res.json.teaser.channels.length).toBeLessThanOrEqual(3)
    expect(Object.keys(res.json.teaser.channels[0]).sort()).toEqual(['name', 'why'])
    const [prop] = await db.select().from(schema.strategies).where(eq(schema.strategies.projectId, projectId))
    expect((await call('GET', `/api/strategies/${prop!.id}`, A)).status).toBe(402)
    expect((await call('GET', `/api/strategy?project=${projectId}`, A)).status).toBe(402)
    expect(mcpAllowed(A.ws, 'read')).toBe(false)
    expect(() => assertClientLinks(A.ws)).toThrow()
  })

  it('nach der Vorschau: kein Job, Chat antwortet mit Hinweis ohne KI, keine Uploads, keine Konten', async () => {
    await enqueueJob(db, 'draft_tasks', { workspaceId: A.ws.id })
    await enqueueJob(db, 'onboard_project', { workspaceId: A.ws.id, payload: { projectId } })
    expect(await claimJob(db, 't')).toBeNull()
    const f = llmFetch('Hallo')
    const [conv] = await db.insert(schema.conversations).values({ workspaceId: A.ws.id, userId: A.user }).returning()
    await db.insert(schema.messages).values({ conversationId: conv!.id, role: 'user', content: 'Schreib mir einen Post' })
    const actor: ChatActor = { workspace: A.ws, userId: A.user, userName: 'Anna', role: 'owner', access: { all: true, ids: [] } }
    await runTurn(db, actor, conv!.id, { llmFetch: f.fn })
    expect(f.state.calls).toBe(0)
    const msgs = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conv!.id))
    expect(msgs.at(-1)!.content).toBe(PAUSED_REPLY)
    expect(msgs.at(-1)!.content).toContain('/abo')
    await expect(assertStorage(db, A.ws, 10)).rejects.toMatchObject({ statusCode: 402, data: { kind: 'trial' } })
    await expect(assertAccountLimit(db, A.ws, 1)).rejects.toMatchObject({ statusCode: 402, data: { kind: 'trial' } })
  })

  it('Tenancy: fremder Workspace sieht das Vorschau-Projekt nicht', async () => {
    const B = await seed('bert', { paused: false })
    expect((await call('GET', `/api/onboarding/${projectId}`, B)).status).toBe(404)
  })

  it('Workspace mit laufendem Tarif: keine Vorschau, normale Analyse ohne Flag', async () => {
    const C = await seed('carla', { paused: false })
    const res = await start(C)
    expect(res.status).toBe(200)
    expect(res.json.preview).toBe(false)
    await reload(C)
    expect(C.ws.previewUsedAt).toBeNull()
    const job = await claimJob(db, 't')
    expect(job!.payload).toEqual({ projectId: res.json.id })
    await expect(assertStorage(db, C.ws, 10)).resolves.toBeUndefined()
  })
})
