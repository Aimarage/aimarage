import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import * as h3 from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withRun } from '../../server/lib/agent'
import { createSession } from '../../server/lib/auth'
import { runTurn, type ChatActor } from '../../server/lib/chat'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { registerExtension, resetExtensions } from '../../server/lib/extensions'
import { claimJob, completeJob, enqueueJob, type JobType } from '../../server/lib/jobs'
import { assertMcp, assertStorage, LimitError, llmSpentMonth, mcpAllowed, resetLimitCache } from '../../server/lib/limits'
import { chat, llmConfig } from '../../server/lib/llm'
import { notify } from '../../server/lib/notify'
import { createProjectRecord } from '../../server/lib/onboarding'
import { resetSecretCache } from '../../server/lib/secret'
import { LocalStorage, purgeWorkspaceStorage, workspaceStorageBytes } from '../../server/lib/storage'
import { MAX_OFFSET_MIN, runOnce, scheduleFor, scheduleTick, shiftTime, workspaceOffset } from '../../server/lib/worker'

const ROOT = resolve(__dirname, '../..')
const g = globalThis as Record<string, unknown>

let db: Db
let close: () => Promise<void>
let web: (req: Request) => Promise<Response>

interface Ws {
  ws: typeof schema.workspaces.$inferSelect
  user: string
  project: string
  cookie: string
}

let A: Ws
let B: Ws

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(f => join(dir, f)).filter(f => f.endsWith('.ts'))
}

async function seed(tag: string): Promise<Ws> {
  const [w] = await db.insert(schema.workspaces).values({
    name: `WS ${tag}`,
    settings: { llm: { provider: 'ollama', model: 'mock' }, social: { accounts: [{ id: `acc-${tag}`, platform: 'bluesky', name: `Konto ${tag}`, profileId: null, profileName: null }] } },
  }).returning()
  const [u] = await db.insert(schema.users).values({ email: `${tag}@limits.local`, name: `User ${tag}` }).returning()
  await db.insert(schema.memberships).values({ workspaceId: w!.id, userId: u!.id, role: 'owner' })
  const [p] = await db.insert(schema.projects).values({ workspaceId: w!.id, slug: `p-${tag}`, name: `Projekt ${tag}`, code: tag.slice(0, 3).toUpperCase(), icon: 'X', url: `https://${tag}.example` }).returning()
  return { ws: w!, user: u!.id, project: p!.id, cookie: await createSession(db, u!.id, w!.id) }
}

async function setLimits(w: Ws, limits: Record<string, unknown> | null, extra: Partial<typeof schema.workspaces.$inferInsert> = {}) {
  const [row] = await db.update(schema.workspaces).set({ limits: limits as never, ...extra }).where(eq(schema.workspaces.id, w.ws.id)).returning()
  w.ws = row!
  resetLimitCache()
}

async function call(method: string, path: string, w: Ws, body?: unknown): Promise<{ status: number, json: Record<string, unknown> }> {
  const headers: Record<string, string> = { cookie: `ma_session=${w.cookie}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await web(new Request(`http://localhost:3210${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text)
  }
  catch {}
  return { status: res.status, json }
}

const okReply = () => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: 'Hallo' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }), { status: 200 })

function countingFetch() {
  const state = { calls: 0 }
  const fn = async () => {
    state.calls++
    return okReply()
  }
  return { fn: fn as unknown as typeof fetch, state }
}

async function clearJobs() {
  await db.delete(schema.jobs)
}

beforeAll(async () => {
  process.env.APP_SECRET = 'test-secret'
  process.env.LLM_PRICE_IN_EUR = '1000'
  process.env.LLM_PRICE_OUT_EUR = '1000'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  g.__maDb = Promise.resolve({ db, close: async () => {} })
  Object.assign(g, h3)
  for (const f of walk(join(ROOT, 'shared/utils'))) Object.assign(g, await import(f))
  for (const f of walk(join(ROOT, 'server/utils'))) Object.assign(g, await import(f))
  A = await seed('alpha')
  B = await seed('beta')
  const app = h3.createApp()
  const router = h3.createRouter()
  const routes: [string, string, h3.RouterMethod][] = [
    ['server/api/projects/index.post.ts', '/api/projects', 'post'],
    ['server/api/projects/[id]/mail.put.ts', '/api/projects/:id/mail', 'put'],
    ['server/api/projects/[id]/client-links.post.ts', '/api/projects/:id/client-links', 'post'],
    ['server/api/projects/[id]/accounts.post.ts', '/api/projects/:id/accounts', 'post'],
    ['server/api/projects/[id].patch.ts', '/api/projects/:id', 'patch'],
  ]
  for (const [file, path, method] of routes) router.use(path, (await import(join(ROOT, file))).default, method)
  app.use(router)
  web = h3.toWebHandler(app)
}, 120_000)

afterAll(async () => {
  delete process.env.APP_SECRET
  delete process.env.LLM_PRICE_IN_EUR
  delete process.env.LLM_PRICE_OUT_EUR
  g.__maDb = undefined
  resetSecretCache()
  resetExtensions()
  await close()
})

beforeEach(() => resetLimitCache())

describe('Limits im Kern', () => {
  it('ohne Limits (null) ist alles erlaubt', async () => {
    await setLimits(A, null)
    const r = await call('POST', '/api/projects', A, { name: 'Zweites' })
    expect(r.status).toBe(200)
  })

  it('Projekt-Limit: HTTP 402 mit { code: limit, kind: projects }', async () => {
    await setLimits(A, { projects: 2 })
    const r = await call('POST', '/api/projects', A, { name: 'Drittes' })
    expect(r.status).toBe(402)
    expect(r.json.data).toEqual({ code: 'limit', kind: 'projects' })
    await expect(createProjectRecord(db, A.ws, A.user, { name: 'Per Chat', url: 'https://x.example' })).rejects.toBeInstanceOf(LimitError)
    await setLimits(A, null)
  })

  it('Konten-Limit greift bei Postfach und Zuordnung', async () => {
    await setLimits(B, { accounts: 1 })
    const mail = { imapHost: 'mail.example.com', imapPort: 993, imapSecure: true, smtpHost: 'mail.example.com', smtpPort: 465, smtpSecure: true, user: 'u', from: 'a@example.com', imapPassword: 'x', smtpPassword: 'x' }
    const r = await call('PUT', `/api/projects/${B.project}/mail`, B, mail)
    expect(r.status).toBe(402)
    expect(r.json.data).toEqual({ code: 'limit', kind: 'accounts' })
    expect((await call('POST', `/api/projects/${B.project}/accounts`, B, { id: 'acc-beta' })).status).toBe(200)
    await setLimits(B, { accounts: 0 })
    expect((await call('POST', `/api/projects/${B.project}/accounts`, B, { id: 'acc-beta' })).status).toBe(402)
    await setLimits(B, null)
  })

  it('ein Konto je Plattform und Projekt (onePerPlatform), sonst unbegrenzt', async () => {
    const accounts = [
      { id: 'acc-beta', platform: 'bluesky', name: 'Konto beta', profileId: null, profileName: null },
      { id: 'acc-beta2', platform: 'Bluesky', name: 'Zweites', profileId: null, profileName: null },
      { id: 'acc-masto', platform: 'mastodon', name: 'Masto', profileId: null, profileName: null },
    ]
    await db.update(schema.projects).set({ setup: {} }).where(eq(schema.projects.id, B.project))
    await setLimits(B, { accounts: null, onePerPlatform: true }, { settings: { ...B.ws.settings, social: { accounts } } })
    expect((await call('POST', `/api/projects/${B.project}/accounts`, B, { id: 'acc-beta' })).status).toBe(200)
    expect((await call('POST', `/api/projects/${B.project}/accounts`, B, { id: 'acc-beta' })).status).toBe(200)
    expect((await call('POST', `/api/projects/${B.project}/accounts`, B, { id: 'acc-masto' })).status).toBe(200)
    const clash = await call('POST', `/api/projects/${B.project}/accounts`, B, { id: 'acc-beta2' })
    expect(clash.status).toBe(409)
    expect(clash.json.data).toEqual({ code: 'one_per_platform', platform: 'bluesky' })
    expect((await call('PATCH', `/api/projects/${B.project}`, B, { social: { profileIds: [], accountIds: ['acc-beta', 'acc-beta2'] } })).status).toBe(409)
    expect((await call('PATCH', `/api/projects/${B.project}`, B, { social: { profileIds: [], accountIds: ['acc-beta2', 'acc-masto'] } })).status).toBe(200)
    await setLimits(B, { accounts: null })
    expect((await call('POST', `/api/projects/${B.project}/accounts`, B, { id: 'acc-beta' })).status).toBe(200)
    await setLimits(B, null)
  })

  it('Kundenlinks und MCP lassen sich abschalten', async () => {
    await setLimits(B, { clientLinks: false })
    const r = await call('POST', `/api/projects/${B.project}/client-links`, B, { label: 'Kunde' })
    expect(r.status).toBe(402)
    expect(r.json.data).toEqual({ code: 'limit', kind: 'clientLinks' })
    expect(mcpAllowed({ limits: { mcp: 'read' } }, 'read')).toBe(true)
    expect(mcpAllowed({ limits: { mcp: 'read' } }, 'write')).toBe(false)
    expect(mcpAllowed({ limits: null }, 'write')).toBe(true)
    expect(() => assertMcp({ limits: { mcp: false } }, 'read')).toThrow(LimitError)
    await setLimits(B, null)
  })

  it('Speicher: gespeicherte Größen zählen, Limit greift', async () => {
    await db.insert(schema.mediaLibrary).values({ workspaceId: B.ws.id, projectId: B.project, name: 'x.png', mime: 'image/png', size: 900 * 1024, file: `${B.ws.id}/fundus/x.png` })
    await setLimits(B, { storageMb: 1 })
    await expect(assertStorage(db, B.ws, 100 * 1024)).resolves.toBeUndefined()
    await expect(assertStorage(db, B.ws, 200 * 1024)).rejects.toMatchObject({ statusCode: 402, kind: 'storageMb' })
    await setLimits(B, { storageMb: 1 }, { storageBytes: 1024 * 1024 })
    await expect(assertStorage(db, B.ws, 1)).rejects.toBeInstanceOf(LimitError)
    await setLimits(B, null, { storageBytes: null })
  })
})

describe('KI-Budget', () => {
  it('jeder LLM-Aufruf landet in agent_runs, auch ohne weitergereichte Kosten', async () => {
    const f = countingFetch()
    const cfg = llmConfig(A.ws.settings.llm, undefined, A.ws.id)
    await withRun(db, A.ws, 'audit_test', {}, async () => {
      await chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, f.fn)
      return { status: 'ok', summary: 'ok' }
    })
    const [run] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.workspaceId, A.ws.id), eq(schema.agentRuns.job, 'audit_test')))
    expect(f.state.calls).toBe(1)
    expect(run!.costEur).toBeCloseTo(2, 5)
    expect(run!.tokensIn).toBe(1000)
    expect(await llmSpentMonth(db, A.ws, true)).toBeGreaterThanOrEqual(2)
  })

  it('aufgebrauchtes Budget: Job endet skipped ohne LLM-Aufruf, Hinweis an den Inhaber', async () => {
    await clearJobs()
    await setLimits(A, { llmEurMonth: 1 })
    const f = countingFetch()
    resetExtensions()
    registerExtension({
      name: 'test-llm',
      jobHandlers: {
        test_llm: async (d, job) => {
          const [ws] = await d.select().from(schema.workspaces).where(eq(schema.workspaces.id, job.workspace_id!))
          await withRun(d, ws!, 'test_llm', {}, async () => {
            await chat(llmConfig(ws!.settings.llm, undefined, ws!.id), { messages: [{ role: 'user', content: 'x' }] }, f.fn)
            return { status: 'ok', summary: 'geschrieben' }
          })
        },
        test_publish: async (d, job) => {
          const [ws] = await d.select().from(schema.workspaces).where(eq(schema.workspaces.id, job.workspace_id!))
          await withRun(d, ws!, 'publish_post', {}, async () => ({ status: 'ok', summary: 'veröffentlicht' }))
        },
      },
    })
    await enqueueJob(db, 'test_llm' as JobType, { workspaceId: A.ws.id })
    expect(await runOnce(db, 't')).toBe(true)
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'test_llm'))
    expect(job!.status).toBe('skipped')
    expect(f.state.calls).toBe(0)
    const [run] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.workspaceId, A.ws.id), eq(schema.agentRuns.job, 'test_llm')))
    expect(run!.status).toBe('skipped')
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.workspaceId, A.ws.id))
    expect(notes.map(n => n.kind)).toEqual(['limit:llmEurMonth'])
    const mails = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'system_mail'))
    expect(mails).toHaveLength(1)
    await enqueueJob(db, 'test_publish' as JobType, { workspaceId: A.ws.id })
    while (await runOnce(db, 't')) { /* Mail-Job und Veröffentlichung abarbeiten */ }
    const [pub] = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'test_publish'))
    expect(pub!.status).toBe('done')
    resetExtensions()
  })

  it('Chat antwortet mit Hinweis statt LLM-Aufruf', async () => {
    const f = countingFetch()
    const [conv] = await db.insert(schema.conversations).values({ workspaceId: A.ws.id, userId: A.user }).returning()
    await db.insert(schema.messages).values({ conversationId: conv!.id, role: 'user', content: 'Schreib mir was' })
    const actor: ChatActor = { workspace: A.ws, userId: A.user, userName: 'A', role: 'owner', access: { all: true, ids: [] } }
    await runTurn(db, actor, conv!.id, { llmFetch: f.fn })
    expect(f.state.calls).toBe(0)
    const msgs = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conv!.id))
    expect(msgs.at(-1)!.content).toMatch(/KI-Budget/)
    await setLimits(A, null)
  })
})

describe('Worker-Fairness', () => {
  it('Versatz 0-45 min, fest je Workspace, Briefing bleibt', () => {
    const o = workspaceOffset(A.ws.id)
    expect(o).toBeGreaterThanOrEqual(0)
    expect(o).toBeLessThanOrEqual(MAX_OFFSET_MIN)
    expect(workspaceOffset(A.ws.id)).toBe(o)
    const ws = { ...A.ws, settings: { ...A.ws.settings, briefingTime: '06:30' } }
    const s = scheduleFor(ws)
    expect(s.find(e => e.type === 'daily_briefing')!.time).toBe('06:30')
    expect(s.find(e => e.type === 'weekly_report')!.time).toBe(shiftTime('14:00', o, '06:30'))
    expect(shiftTime('05:30', 45, '06:30')).toBe('06:15')
    expect(shiftTime('06:00', 45, '06:30')).toBe('06:20')
    expect(shiftTime('04:00', 30, '06:30')).toBe('04:30')
    expect(shiftTime('07:00', 45, '06:30')).toBe('07:45')
    const offsets = new Set(Array.from({ length: 20 }, (_, i) => workspaceOffset(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`)))
    expect(offsets.size).toBeGreaterThan(5)
  })

  it('Workspace mit laufendem Job wird übersprungen, Posts mit festem Zeitpunkt nicht', async () => {
    await clearJobs()
    await enqueueJob(db, 'draft_tasks', { workspaceId: A.ws.id, dedupeKey: 'a1' })
    await enqueueJob(db, 'strategy_review', { workspaceId: A.ws.id, dedupeKey: 'a2' })
    await enqueueJob(db, 'draft_tasks', { workspaceId: B.ws.id, dedupeKey: 'b1' })
    const first = await claimJob(db, 'w1')
    expect(first!.workspace_id).toBe(A.ws.id)
    const second = await claimJob(db, 'w2')
    expect(second!.workspace_id).toBe(B.ws.id)
    expect(await claimJob(db, 'w3')).toBeNull()
    await enqueueJob(db, 'publish_post', { workspaceId: A.ws.id, payload: { postId: 'x' }, dedupeKey: 'a3' })
    const timed = await claimJob(db, 'w3')
    expect(timed!.type).toBe('publish_post')
    await completeJob(db, first!.id)
    const next = await claimJob(db, 'w1')
    expect(next!.type).toBe('strategy_review')
  })

  it('pausierter oder gelöschter Workspace: keine geplanten Jobs, Warteschlange ruht', async () => {
    await clearJobs()
    await setLimits(B, null, { pausedAt: new Date() })
    await scheduleTick(db)
    const jobs = await db.select().from(schema.jobs)
    expect(jobs.some(j => j.workspaceId === B.ws.id)).toBe(false)
    expect(jobs.some(j => j.workspaceId === A.ws.id)).toBe(true)
    expect(jobs.some(j => j.workspaceId === null && j.type === 'auth_cleanup')).toBe(true)
    await clearJobs()
    await enqueueJob(db, 'draft_tasks', { workspaceId: B.ws.id })
    expect(await claimJob(db, 'w')).toBeNull()
    await setLimits(B, null, { pausedAt: null, deletedAt: new Date() })
    expect(await claimJob(db, 'w')).toBeNull()
    await setLimits(B, null, { deletedAt: null })
    expect((await claimJob(db, 'w'))!.workspace_id).toBe(B.ws.id)
    await clearJobs()
  })
})

describe('Benachrichtigungen und Ablage', () => {
  it('notify legt Eintrag an, verschickt Mail einmal je Schlüssel', async () => {
    await clearJobs()
    const text = { de: { subject: 'Test', body: 'Hallo' } }
    expect(await notify(db, B.ws, null, 'test', { text }, { dedupeKey: 'k1' })).toBe(1)
    expect(await notify(db, B.ws, null, 'test', { text }, { dedupeKey: 'k1' })).toBe(0)
    expect(await notify(db, B.ws, B.user, 'test2', { text })).toBe(1)
    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.workspaceId, B.ws.id))
    expect(rows).toHaveLength(2)
    const mails = await db.select({ n: sql<number>`count(*)::int` }).from(schema.jobs).where(eq(schema.jobs.type, 'system_mail'))
    expect(mails[0]!.n).toBe(2)
    await clearJobs()
  })

  it('purgeWorkspaceStorage löscht nur den eigenen Präfix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'purge-'))
    const s = new LocalStorage(dir)
    await s.put(`${A.ws.id}/d1/a.txt`, new Uint8Array([1, 2, 3]))
    await s.put(`${A.ws.id}/fundus/p/b.txt`, new Uint8Array([1]))
    await s.put(`${B.ws.id}/d1/c.txt`, new Uint8Array([1, 2]))
    expect(await workspaceStorageBytes(A.ws.id, s)).toBe(4)
    expect((await s.list(A.ws.id)).map(o => relative(A.ws.id, o.key))).toEqual(['d1/a.txt', 'fundus/p/b.txt'])
    expect(await purgeWorkspaceStorage(A.ws.id, s)).toBe(2)
    expect((await s.list()).map(o => o.key)).toEqual([`${B.ws.id}/d1/c.txt`])
    expect(await s.list('fehlt')).toEqual([])
  })
})
