import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import * as h3 from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reviewerAsk, reviewerEnabled } from '../../server/lib/ai-reviewer'
import { createSession } from '../../server/lib/auth'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { resetSecretCache } from '../../server/lib/secret'

const ROOT = resolve(__dirname, '../..')
const g = globalThis as Record<string, unknown>

let db: Db
let close: () => Promise<void>
let web: (req: Request) => Promise<Response>

interface Ws {
  id: string
  owner: { id: string, cookie: string }
  member: { id: string, cookie: string }
}

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(f => join(dir, f)).filter(f => f.endsWith('.ts'))
}

async function seed(tag: string, settings: Record<string, unknown>): Promise<Ws> {
  const [w] = await db.insert(schema.workspaces).values({ name: `WS ${tag}`, settings }).returning()
  const [o] = await db.insert(schema.users).values({ email: `${tag}-o@rv.local`, name: `Inhaber ${tag}` }).returning()
  const [m] = await db.insert(schema.users).values({ email: `${tag}-m@rv.local`, name: `Mitglied ${tag}` }).returning()
  await db.insert(schema.memberships).values([{ workspaceId: w!.id, userId: o!.id, role: 'owner' }, { workspaceId: w!.id, userId: m!.id, role: 'member' }])
  return { id: w!.id, owner: { id: o!.id, cookie: await createSession(db, o!.id, w!.id) }, member: { id: m!.id, cookie: await createSession(db, m!.id, w!.id) } }
}

async function wsRow(w: Ws) {
  const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w.id))
  return row!
}

async function call(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number, json: Record<string, any> }> {
  const headers: Record<string, string> = { cookie: `ma_session=${cookie}` }
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

beforeAll(async () => {
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  g.__maDb = Promise.resolve({ db, close: async () => {} })
  Object.assign(g, h3)
  for (const f of walk(join(ROOT, 'shared/utils'))) Object.assign(g, await import(f))
  for (const f of walk(join(ROOT, 'server/utils'))) Object.assign(g, await import(f))
  const app = h3.createApp()
  const router = h3.createRouter()
  const routes: [string, string, h3.RouterMethod][] = [
    ['server/api/settings/index.get.ts', '/api/settings', 'get'],
    ['server/api/settings/index.patch.ts', '/api/settings', 'patch'],
    ['server/api/me/index.get.ts', '/api/me', 'get'],
  ]
  for (const [file, path, method] of routes) router.use(path, (await import(join(ROOT, file))).default, method)
  app.use(router)
  web = h3.toWebHandler(app)
}, 120_000)

afterAll(async () => {
  delete process.env.APP_SECRET
  g.__maDb = undefined
  resetSecretCache()
  await close()
})

describe('KI-Prüfer als bewusste Wahl', () => {
  it('bestehende Arbeitsbereiche ohne Eintrag behalten "an" und werden nicht gefragt', () => {
    expect(reviewerEnabled({ settings: {} })).toBe(true)
    expect(reviewerAsk({ settings: {} })).toBe(false)
    expect(reviewerEnabled({ settings: { aiReviewer: { enabled: true } } })).toBe(true)
  })

  it('neue Arbeitsbereiche: aus und offene Frage', () => {
    const ws = { settings: { aiReviewer: { enabled: false, ask: true } } }
    expect(reviewerEnabled(ws)).toBe(false)
    expect(reviewerAsk(ws)).toBe(true)
  })

  it('Frage erscheint in /api/me und /api/settings, Mitglied darf nicht wählen', async () => {
    const w = await seed('neu', { aiReviewer: { enabled: false, ask: true } })
    expect((await call('GET', '/api/me', w.owner.cookie)).json.workspace.reviewerAsk).toBe(true)
    const s = await call('GET', '/api/settings', w.owner.cookie)
    expect(s.json.aiReviewer).toMatchObject({ enabled: false, ask: true, by: null, at: null })
    expect((await call('PATCH', '/api/settings', w.member.cookie, { aiReviewer: { enabled: true } })).status).toBe(403)
    expect((await wsRow(w)).settings.aiReviewer).toEqual({ enabled: false, ask: true })
  })

  it('Nein: bleibt aus, Frage erledigt, wer und wann gespeichert', async () => {
    const w = await seed('nein', { aiReviewer: { enabled: false, ask: true } })
    expect((await call('PATCH', '/api/settings', w.owner.cookie, { aiReviewer: { enabled: false } })).status).toBe(200)
    const cfg = (await wsRow(w)).settings.aiReviewer!
    expect(cfg).toMatchObject({ enabled: false, by: w.owner.id })
    expect(cfg.ask).toBeUndefined()
    expect(Number.isNaN(Date.parse(cfg.at!))).toBe(false)
    expect((await call('GET', '/api/me', w.owner.cookie)).json.workspace.reviewerAsk).toBe(false)
    const log = await db.select().from(schema.activity).where(and(eq(schema.activity.workspaceId, w.id), eq(schema.activity.action, 'ai_reviewer_off')))
    expect(log).toHaveLength(1)
    expect(log[0]!.userId).toBe(w.owner.id)
  })

  it('Ja: an, in den Einstellungen mit Name sichtbar und jederzeit änderbar', async () => {
    const w = await seed('ja', { aiReviewer: { enabled: false, ask: true } })
    await call('PATCH', '/api/settings', w.owner.cookie, { aiReviewer: { enabled: true } })
    expect(reviewerEnabled(await wsRow(w))).toBe(true)
    const s = await call('GET', '/api/settings', w.owner.cookie)
    expect(s.json.aiReviewer).toMatchObject({ enabled: true, ask: false, by: 'Inhaber ja' })
    await call('PATCH', '/api/settings', w.owner.cookie, { aiReviewer: { enabled: false } })
    expect(reviewerEnabled(await wsRow(w))).toBe(false)
  })
})
