import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import * as h3 from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentReady, withRun, workspaceLlm } from '../../server/lib/agent'
import { createSession } from '../../server/lib/auth'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { registerExtension, resetExtensions } from '../../server/lib/extensions'
import { llmSpentMonth, resetLimitCache } from '../../server/lib/limits'
import { chat, OWN_MIN_TOKENS } from '../../server/lib/llm'
import { ownLlmConfig, ownLlmFor } from '../../server/lib/own-llm'
import { resetSecretCache } from '../../server/lib/secret'

const ROOT = resolve(__dirname, '../..')
const g = globalThis as Record<string, unknown>
const KEY = 'sk-own-test-key-0123456789WXYZ'

let db: Db
let close: () => Promise<void>
let web: (req: Request) => Promise<Response>

interface Ws {
  id: string
  user: string
  cookie: string
}

let A: Ws

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(f => join(dir, f)).filter(f => f.endsWith('.ts'))
}

async function seed(tag: string): Promise<Ws> {
  const [w] = await db.insert(schema.workspaces).values({ name: `WS ${tag}`, settings: {} }).returning()
  const [u] = await db.insert(schema.users).values({ email: `${tag}@own.local`, name: `User ${tag}` }).returning()
  await db.insert(schema.memberships).values({ workspaceId: w!.id, userId: u!.id, role: 'owner' })
  return { id: w!.id, user: u!.id, cookie: await createSession(db, u!.id, w!.id) }
}

async function wsRow(w: Ws) {
  const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w.id))
  return row!
}

async function call(method: string, path: string, w: Ws, body?: unknown): Promise<{ status: number, text: string, json: Record<string, any> }> {
  const headers: Record<string, string> = { cookie: `ma_session=${w.cookie}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await web(new Request(`http://localhost:3210${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  let json: Record<string, any> = {}
  try {
    json = JSON.parse(text)
  }
  catch {}
  return { status: res.status, text, json }
}

function fakeFetch(reply: (url: string, body: Record<string, unknown>) => Response) {
  const calls: { url: string, body: Record<string, unknown>, headers: Record<string, string> }[] = []
  const fn = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ url, body, headers: init.headers as Record<string, string> })
    return reply(url, body)
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

const ok = () => new Response(JSON.stringify({ model: 'mistral-medium-3-5', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }), { status: 200 })

beforeAll(async () => {
  process.env.APP_SECRET = 'test-secret'
  process.env.LLM_SETTINGS_LOCKED = 'true'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  g.__maDb = Promise.resolve({ db, close: async () => {} })
  Object.assign(g, h3)
  for (const f of walk(join(ROOT, 'shared/utils'))) Object.assign(g, await import(f))
  for (const f of walk(join(ROOT, 'server/utils'))) Object.assign(g, await import(f))
  A = await seed('alpha')
  const app = h3.createApp()
  const router = h3.createRouter()
  const routes: [string, string, h3.RouterMethod][] = [
    ['server/api/settings/own-llm.get.ts', '/api/settings/own-llm', 'get'],
    ['server/api/settings/own-llm.patch.ts', '/api/settings/own-llm', 'patch'],
    ['server/api/settings/own-llm-test.post.ts', '/api/settings/own-llm-test', 'post'],
    ['server/api/settings/index.get.ts', '/api/settings', 'get'],
    ['server/api/settings/index.patch.ts', '/api/settings', 'patch'],
  ]
  for (const [file, path, method] of routes) router.use(path, (await import(join(ROOT, file))).default, method)
  app.use(router)
  web = h3.toWebHandler(app)
}, 120_000)

afterAll(async () => {
  delete process.env.APP_SECRET
  delete process.env.LLM_SETTINGS_LOCKED
  g.__maDb = undefined
  resetSecretCache()
  resetExtensions()
  vi.unstubAllGlobals()
  await close()
})

beforeEach(() => {
  resetExtensions()
  registerExtension({ name: 'saas-test', ownLlm: ws => !ws.pausedAt })
  resetLimitCache()
})

describe('Eigener KI-Schlüssel: Einstellungen', () => {
  it('ohne Freischaltung durch die Erweiterung gesperrt (Selbst-Hoster nutzen die normalen Einstellungen)', async () => {
    resetExtensions()
    const r = await call('PATCH', '/api/settings/own-llm', A, { provider: 'mistral', apiKey: KEY })
    expect(r.status).toBe(403)
    expect((await call('GET', '/api/settings/own-llm', A)).json.available).toBe(false)
  })

  it('Schlüssel wird verschlüsselt gespeichert und nie zurückgegeben', async () => {
    const r = await call('PATCH', '/api/settings/own-llm', A, { provider: 'mistral', model: 'mistral-medium-3-5', apiKey: KEY })
    expect(r.status).toBe(200)
    const ws = await wsRow(A)
    expect(JSON.stringify(ws.settings)).not.toContain(KEY)
    expect(ws.settings.ownLlm?.key?.enc.startsWith('v1.')).toBe(true)
    const get = await call('GET', '/api/settings/own-llm', A)
    expect(get.text).not.toContain(KEY)
    expect(get.text).not.toContain(ws.settings.ownLlm!.key!.enc)
    expect(get.json.key).toMatchObject({ set: true, hint: 'WXYZ' })
    expect(get.json.active).toBe(true)
    const all = await call('GET', '/api/settings', A)
    expect(all.text).not.toContain(KEY)
    expect(all.text).not.toContain(ws.settings.ownLlm!.key!.enc)
    expect(all.json.llm.own).toBe(true)
    const cfg = ownLlmFor(ws)!
    expect(cfg.apiKey).toBe(KEY)
    expect(cfg.baseUrl).toBe('https://api.mistral.ai/v1')
    expect(workspaceLlm(ws, 'draft_article').own).toBe(true)
  })

  it('gehostet keine frei wählbare Adresse: baseUrl wird abgelehnt, umgebogene Adresse bekommt keinen Schlüssel', async () => {
    const r = await call('PATCH', '/api/settings/own-llm', A, { provider: 'openai', baseUrl: 'http://169.254.169.254/v1', apiKey: KEY })
    expect(r.status).toBe(400)
    expect((await call('POST', '/api/settings/own-llm-test', A, { provider: 'openai', baseUrl: 'http://10.0.0.1/v1' })).status).toBe(400)
    expect((await call('PATCH', '/api/settings/own-llm', A, { provider: 'custom', apiKey: KEY })).status).toBe(400)
    expect((await call('PATCH', '/api/settings', A, { llm: { provider: 'custom', baseUrl: 'https://evil.example/v1' } })).status).toBe(403)
    const ws = await wsRow(A)
    const forged = { ...ws.settings.ownLlm!, key: { ...ws.settings.ownLlm!.key!, baseUrl: 'https://evil.example/v1' } }
    const cfg = ownLlmConfig(forged, A.id)!
    expect(cfg.baseUrl).toBe('https://api.mistral.ai/v1')
    expect(cfg.apiKey).toBe('')
    expect(cfg.blocked).toBeTruthy()
  })

  it('gesperrt in pausierten Workspaces (auch Vorschau ohne Karte), Entfernen geht trotzdem', async () => {
    await db.update(schema.workspaces).set({ pausedAt: new Date() }).where(eq(schema.workspaces.id, A.id))
    const r = await call('PATCH', '/api/settings/own-llm', A, { provider: 'mistral', apiKey: KEY })
    expect(r.status).toBe(402)
    expect(r.json.data).toEqual({ code: 'limit', kind: 'trial' })
    expect((await call('POST', '/api/settings/own-llm-test', A, {})).status).toBe(402)
    const ws = await wsRow(A)
    expect(ownLlmFor(ws)).toBeNull()
    expect(workspaceLlm(ws).own).toBeFalsy()
    const get = await call('GET', '/api/settings/own-llm', A)
    expect(get.json).toMatchObject({ available: true, allowed: false, paused: true, active: false })
    await db.update(schema.workspaces).set({ pausedAt: null }).where(eq(schema.workspaces.id, A.id))
  })

  it('Verbindung testen nutzt die feste Adresse und gibt den Schlüssel nicht zurück', async () => {
    const f = fakeFetch(() => ok())
    vi.stubGlobal('fetch', f.fn)
    const r = await call('POST', '/api/settings/own-llm-test', A, { provider: 'mistral', model: 'mistral-medium-3-5' })
    vi.unstubAllGlobals()
    expect(r.json.ok).toBe(true)
    expect(f.calls[0]!.url).toBe('https://api.mistral.ai/v1/chat/completions')
    expect(f.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(r.text).not.toContain(KEY)
  })
})

describe('Eigener KI-Schlüssel: Budget und Fehler', () => {
  it('Aufrufe über den eigenen Schlüssel belasten das KI-Budget nicht, auch wenn es aufgebraucht ist', async () => {
    await db.update(schema.workspaces).set({ limits: { llmEurMonth: 0.0001 } }).where(eq(schema.workspaces.id, A.id))
    await db.insert(schema.agentRuns).values({ workspaceId: A.id, job: 'alt', status: 'ok', costEur: 0.5 })
    const ws = await wsRow(A)
    const before = await llmSpentMonth(db, ws, true)
    const f = fakeFetch(() => ok())
    const out = await withRun(db, ws, 'own_budget', {}, async (ctx) => {
      ctx.usage.push(await chat(workspaceLlm(ws, 'draft_social'), { messages: [{ role: 'user', content: 'x' }] }, f.fn))
      return { status: 'ok', summary: 'geschrieben' }
    })
    expect(out.status).toBe('ok')
    expect(f.calls).toHaveLength(1)
    const [run] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.workspaceId, A.id), eq(schema.agentRuns.job, 'own_budget')))
    expect(run!.costEur).toBeGreaterThan(0)
    expect(run!.ownCostEur).toBeCloseTo(run!.costEur, 6)
    expect(await llmSpentMonth(db, ws, true)).toBeCloseTo(before, 6)
    const get = await call('GET', '/api/settings/own-llm', A)
    expect(get.json.usage.runs).toBeGreaterThanOrEqual(1)
  })

  it('denkende Modelle bekommen großzügig Token, OpenAI-Reasoning-Modelle max_completion_tokens ohne temperature', async () => {
    const ws = await wsRow(A)
    const f = fakeFetch(() => ok())
    await chat(workspaceLlm(ws), { messages: [{ role: 'user', content: 'x' }], maxTokens: 400 }, f.fn)
    expect(f.calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(OWN_MIN_TOKENS)
    const oai = ownLlmConfig({ provider: 'openai', key: ws.settings.ownLlm!.key }, A.id)!
    expect(oai.apiKey).toBe('')
    const g2 = fakeFetch(() => ok())
    await chat({ ...oai, blocked: undefined, apiKey: 'sk-x-123456789' }, { messages: [{ role: 'user', content: 'x' }], maxTokens: 400 }, g2.fn)
    expect(g2.calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(g2.calls[0]!.body.max_completion_tokens).toBeGreaterThanOrEqual(OWN_MIN_TOKENS)
    expect(g2.calls[0]!.body).not.toHaveProperty('max_tokens')
    expect(g2.calls[0]!.body).not.toHaveProperty('temperature')
    expect(oai.timeoutMs).toBeGreaterThanOrEqual(240_000)
  })

  it('Schlüssel abgelehnt: kein Rückfall auf unsere KI, Job endet sauber, Admin bekommt Hinweis, nach Behebung geht es weiter', async () => {
    await db.delete(schema.jobs)
    const ws = await wsRow(A)
    const f = fakeFetch(() => new Response(`{"error":"Incorrect API key provided: ${KEY}"}`, { status: 401 }))
    const out = await withRun(db, ws, 'own_fail', {}, async (ctx) => {
      ctx.usage.push(await chat(workspaceLlm(ws, 'draft_social'), { messages: [{ role: 'user', content: 'x' }] }, f.fn))
      return { status: 'ok', summary: 'geschrieben' }
    })
    expect(out.status).toBe('skipped')
    expect(out.summary).toMatch(/Eigener KI-Schlüssel/)
    expect(f.calls).toHaveLength(1)
    expect(f.calls.every(c => c.url.startsWith('https://api.mistral.ai/'))).toBe(true)
    const [run] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.workspaceId, A.id), eq(schema.agentRuns.job, 'own_fail')))
    expect(run!.status).toBe('error')
    expect(`${run!.summary}${run!.log}`).not.toContain(KEY)
    const after = await wsRow(A)
    expect(after.settings.ownLlm?.error?.code).toBe('auth')
    expect(after.settings.ownLlm?.error?.message).not.toContain(KEY)
    expect(agentReady(after)).toBe(false)
    expect(workspaceLlm(after).own).toBe(true)
    const notes = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, A.id), eq(schema.notifications.kind, 'own_llm')))
    expect(notes).toHaveLength(1)
    const blocked = fakeFetch(() => ok())
    await expect(chat(workspaceLlm(after), { messages: [{ role: 'user', content: 'x' }] }, blocked.fn)).rejects.toThrow(/gesperrt/)
    expect(blocked.calls).toHaveLength(0)
    const get = await call('GET', '/api/settings/own-llm', A)
    expect(get.json.error).toMatchObject({ code: 'auth', active: true })
    expect(get.text).not.toContain(KEY)
    const fix = await call('PATCH', '/api/settings/own-llm', A, { apiKey: 'sk-new-own-key-99998888' })
    expect(fix.status).toBe(200)
    const fixed = await wsRow(A)
    expect(fixed.settings.ownLlm?.error).toBeUndefined()
    expect(agentReady(fixed)).toBe(true)
    const jobs = await db.select().from(schema.jobs).where(and(eq(schema.jobs.workspaceId, A.id), eq(schema.jobs.type, 'draft_tasks')))
    expect(jobs).toHaveLength(1)
  })

  it('Guthaben aufgebraucht (429 quota) wird nicht wiederholt und sperrt nur befristet', async () => {
    const ws = await wsRow(A)
    const f = fakeFetch(() => new Response('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', { status: 429 }))
    await withRun(db, ws, 'own_quota', {}, async (ctx) => {
      ctx.usage.push(await chat(workspaceLlm(ws), { messages: [{ role: 'user', content: 'x' }] }, f.fn))
      return { status: 'ok', summary: 'x' }
    })
    expect(f.calls).toHaveLength(1)
    const after = await wsRow(A)
    expect(after.settings.ownLlm?.error?.code).toBe('quota')
    expect(after.settings.ownLlm?.error?.until).toBeTruthy()
  })

  it('Entfernen: zurück auf unsere KI', async () => {
    const r = await call('PATCH', '/api/settings/own-llm', A, { remove: true })
    expect(r.status).toBe(200)
    const ws = await wsRow(A)
    expect(ws.settings.ownLlm).toBeUndefined()
    expect(workspaceLlm(ws).own).toBeFalsy()
    expect((await call('GET', '/api/settings/own-llm', A)).json.key.set).toBe(false)
  })
})
