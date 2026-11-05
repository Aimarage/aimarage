import { eq } from 'drizzle-orm'
import * as h3 from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { morningMailOn, readUnsubscribeToken, unsubscribeHeaders, unsubscribeToken, unsubscribeUrl } from '../../server/lib/mail-unsubscribe'
import { runMorningMail, sendMorningDigest } from '../../server/lib/morning-digest'
import { resetSecretCache } from '../../server/lib/secret'
import { deliverSystemMail, runSystemMailJob, setSystemMailTransport, type SystemMailMessage } from '../../server/lib/system-mail'
import { renderSystemMail } from '../../server/mail-templates'

const g = globalThis as Record<string, unknown>
let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let user: string
let web: (r: Request) => Promise<Response>
const prev = { now: process.env.MA_NOW, secret: process.env.APP_SECRET, smtp: process.env.SMTP_URL }

async function prefs() {
  return (await db.select({ prefs: schema.users.prefs }).from(schema.users).where(eq(schema.users.id, user)))[0]!.prefs
}

async function queueDigest() {
  await db.delete(schema.notifications)
  await db.delete(schema.jobs)
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))
  await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p!.id, code: `M-${Date.now() % 1000}`, title: 'Heute erledigen', category: 'pflege', humanStep: 'Erledigen', assigneeUserId: user, dueDate: '2026-10-13', estimateMin: 5 })
  expect(await sendMorningDigest(db, ws)).toBe(1)
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:00:00Z'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  g.__maDb = Promise.resolve({ db, close: async () => {} })
  Object.assign(g, h3)
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', timezone: 'Europe/Vienna' }).returning())[0]!
  user = (await db.insert(schema.users).values({ email: 'peter@firma.at', name: 'Peter' }).returning())[0]!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: user, role: 'owner' })
  await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'a', name: 'A', code: 'AAA', icon: 'A' })
  const app = h3.createApp()
  const router = h3.createRouter()
  router.use('/mail/abmelden', (await import('../../server/routes/mail/abmelden')).default)
  app.use(router)
  web = h3.toWebHandler(app)
})

afterAll(async () => {
  for (const [k, v] of [['MA_NOW', prev.now], ['APP_SECRET', prev.secret], ['SMTP_URL', prev.smtp]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  g.__maDb = undefined
  setSystemMailTransport(null)
  resetSecretCache()
  await close()
})

describe('Tagesmail abbestellen', () => {
  it('Token: nur mit gültiger Signatur, Standard ist an', () => {
    const t = unsubscribeToken(user)
    expect(readUnsubscribeToken(t)).toBe(user)
    expect(readUnsubscribeToken(`${t.split('.')[0]}.falsch`)).toBeNull()
    expect(readUnsubscribeToken('kaputt')).toBeNull()
    expect(unsubscribeUrl(user)).toMatch(/\/mail\/abmelden\?t=[\w-]+\.[\w-]+$/)
    expect(unsubscribeHeaders(user)).toEqual({ 'List-Unsubscribe': `<${unsubscribeUrl(user)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    expect(morningMailOn({})).toBe(true)
    expect(morningMailOn({ morningMailOff: true })).toBe(false)
  })

  it('Mail hat Abmeldelink und List-Unsubscribe-Header', async () => {
    await queueDigest()
    expect(await runMorningMail(db, user)).toBe(1)
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'system_mail'))
    const payload = job!.payload as { vars: { unsubscribeUrl: string, subject: string, body: string }, headers: Record<string, string> }
    expect(payload.vars.unsubscribeUrl).toBe(unsubscribeUrl(user))
    expect(payload.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(renderSystemMail('generic-notice', payload.vars, 'de').text).toContain(`Abbestellen: ${unsubscribeUrl(user)}`)
    const sent: SystemMailMessage[] = []
    setSystemMailTransport({ sendMail: async (m) => { sent.push(m) } })
    process.env.SMTP_URL = 'smtp://test'
    await runSystemMailJob(job!.payload)
    expect(sent[0]!.headers['List-Unsubscribe']).toBe(`<${unsubscribeUrl(user)}>`)
    expect(sent[0]!.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    await deliverSystemMail('peter@firma.at', 'x', { subject: 's', text: 't', html: 'h' }, { headers: { 'Bcc': 'fremd@example.org', 'List-Unsubscribe': 'a\r\nBcc: x' } })
    expect(sent[1]!.headers).not.toHaveProperty('Bcc')
    expect(sent[1]!.headers).not.toHaveProperty('List-Unsubscribe')
  })

  it('Link ohne Login: GET zeigt nur den Knopf, POST (One-Click) bestellt ab', async () => {
    const url = `http://localhost:3210/mail/abmelden?t=${unsubscribeToken(user)}`
    const get = await web(new Request(url))
    expect(get.status).toBe(200)
    expect(await get.text()).toContain('<form method="post"')
    expect(morningMailOn(await prefs())).toBe(true)
    const post = await web(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }))
    expect(post.status).toBe(200)
    expect(await post.text()).toContain('Erledigt')
    expect(morningMailOn(await prefs())).toBe(false)
    expect((await web(new Request('http://localhost:3210/mail/abmelden?t=x.y', { method: 'POST' }))).status).toBe(404)
  })

  it('abbestellt: keine Mail, die Nachricht bleibt im Dashboard', async () => {
    await queueDigest()
    expect(await runMorningMail(db, user)).toBe(0)
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'system_mail'))).toHaveLength(0)
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, user))).toHaveLength(1)
    expect(await runMorningMail(db, user)).toBe(0)
  })
})
