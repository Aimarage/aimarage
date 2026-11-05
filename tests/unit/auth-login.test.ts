import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, tokenHash } from '../../server/lib/auth'
import { issueRegistrationToken, readRegistrationToken } from '../../server/lib/auth-codes'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { registerExtension, resetExtensions } from '../../server/lib/extensions'
import { resetSecretCache } from '../../server/lib/secret'
import { setSystemMailTransport, type SystemMailMessage } from '../../server/lib/system-mail'

// Gemockte WebAuthn-Prüfung: Die "Antwort" trägt die Challenge im Feld clientDataJSON,
// damit die Bindung an die gespeicherte Challenge geprüft wird.
const wa = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], n: 0 }))
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async (o: Record<string, unknown>) => ({ challenge: `reg-${++wa.n}`, rp: { id: o.rpID }, authenticatorSelection: o.authenticatorSelection })),
  generateAuthenticationOptions: vi.fn(async (o: Record<string, unknown>) => ({ challenge: `auth-${++wa.n}`, rpId: o.rpID, userVerification: o.userVerification, allowCredentials: o.allowCredentials })),
  verifyRegistrationResponse: vi.fn(async (o: { response: { id: string, response: { clientDataJSON: string } }, expectedChallenge: string } & Record<string, unknown>) => {
    wa.calls.push(o)
    if (o.response.response.clientDataJSON !== o.expectedChallenge) throw new Error('challenge mismatch')
    return { verified: true, registrationInfo: { credential: { id: o.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] }, credentialDeviceType: 'multiDevice', credentialBackedUp: true } }
  }),
  verifyAuthenticationResponse: vi.fn(async (o: { response: { response: { clientDataJSON: string } }, expectedChallenge: string, credential: { counter: number } } & Record<string, unknown>) => {
    wa.calls.push(o)
    if (o.response.response.clientDataJSON !== o.expectedChallenge) throw new Error('challenge mismatch')
    return { verified: true, authenticationInfo: { newCounter: o.credential.counter + 1 } }
  }),
}))

const ROOT = resolve(__dirname, '../..')
const g = globalThis as Record<string, unknown>
let db: Db
let close: () => Promise<void>
let web: (req: Request) => Promise<Response>
let sent: SystemMailMessage[] = []
let ws: string
let ws2: string
let anna: string
let ipN = 0
const ENV = ['HOSTED', 'AUTH_PASSWORD', 'MA_NOW']

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(f => join(dir, f)).filter(f => f.endsWith('.ts'))
}

function routeOf(file: string): { method: string | undefined, path: string } {
  let rel = relative(join(ROOT, 'server/api'), file).replace(/\.ts$/, '')
  let method: string | undefined
  const m = /\.(get|post|put|patch|delete)$/.exec(rel)
  if (m) {
    method = m[1]
    rel = rel.slice(0, -m[0].length)
  }
  rel = rel.replace(/(^|\/)index$/, '')
  return { method, path: `/api/${rel}`.replace(/\/+$/, '').replace(/\[(\w+)\]/g, ':$1') }
}

interface Res { status: number, body: Record<string, any>, cookie: string | null }

async function call(method: string, path: string, opts: { cookie?: string, body?: unknown, ip?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? '10.0.0.1', 'user-agent': 'Mozilla/5.0 (Macintosh) Firefox/140.0' }
  if (opts.cookie) headers.cookie = `ma_session=${opts.cookie}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await web(new Request(`http://localhost:3210${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }))
  const text = await res.text()
  const set = res.headers.getSetCookie().find(c => c.startsWith('ma_session='))
  const cookie = set ? decodeURIComponent(set.split(';')[0]!.slice('ma_session='.length)) : null
  let body: Record<string, any> = {}
  try {
    body = JSON.parse(text)
  }
  catch {}
  return { status: res.status, body, cookie }
}

function freshIp(): string {
  return `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}`
}

function lastCode(to?: string): string {
  const m = [...sent].reverse().find(x => !to || x.to === to)
  const code = /\b(\d{6})\b/.exec(m?.subject ?? '')?.[1]
  if (!code) throw new Error(`Kein Code in den Mails an ${to}`)
  return code
}

async function loginByCode(email: string): Promise<Res> {
  const ip = freshIp()
  expect((await call('POST', '/api/auth/code/request', { body: { email }, ip })).status).toBe(200)
  return call('POST', '/api/auth/code/verify', { body: { email, code: lastCode(email) }, ip })
}

function shiftNow(minutes: number) {
  process.env.MA_NOW = new Date(Date.now() + minutes * 60_000).toISOString()
}

async function oldSession(userId: string, workspaceId = ws): Promise<string> {
  return createSession(db, userId, workspaceId, { method: 'password' })
}

beforeAll(async () => {
  process.env.APP_SECRET = 'test-secret-auth'
  process.env.TRUST_PROXY = 'true'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  g.__maDb = Promise.resolve({ db, close: async () => {} })
  Object.assign(g, h3)
  for (const f of walk(join(ROOT, 'shared/utils'))) Object.assign(g, await import(f))
  for (const f of walk(join(ROOT, 'server/utils'))) Object.assign(g, await import(f))
  const [w] = await db.insert(schema.workspaces).values({ name: 'Kunde' }).returning()
  const [w2] = await db.insert(schema.workspaces).values({ name: 'Zweiter' }).returning()
  ws = w!.id
  ws2 = w2!.id
  const [u] = await db.insert(schema.users).values({ email: 'Anna@Kunde.at', name: 'Anna' }).returning()
  anna = u!.id
  await db.insert(schema.memberships).values({ workspaceId: ws, userId: anna, role: 'owner' })
  await db.insert(schema.memberships).values({ workspaceId: ws2, userId: anna, role: 'member', createdAt: new Date(Date.now() + 1000) })
  const [b] = await db.insert(schema.users).values({ email: 'bert@kunde.at', name: 'Bert' }).returning()
  await db.insert(schema.memberships).values({ workspaceId: ws, userId: b!.id, role: 'member' })
  const app = h3.createApp()
  const router = h3.createRouter()
  for (const f of [...walk(join(ROOT, 'server/api/auth')), ...walk(join(ROOT, 'server/api/me'))]) {
    const r = routeOf(f)
    router.use(r.path, (await import(f)).default, r.method as h3.RouterMethod | undefined)
  }
  app.use(router)
  web = h3.toWebHandler(app)
}, 120_000)

beforeEach(() => {
  sent = []
  setSystemMailTransport({ async sendMail(msg) { sent.push(msg) } })
  process.env.SMTP_URL = 'smtp://fake'
})

afterEach(async () => {
  setSystemMailTransport(null)
  for (const k of ENV) delete process.env[k]
  delete process.env.SMTP_URL
  resetExtensions()
  await db.delete(schema.rateLimits)
})

afterAll(async () => {
  delete process.env.APP_SECRET
  delete process.env.TRUST_PROXY
  g.__maDb = undefined
  resetSecretCache()
  await close()
})

describe('Anmeldung per Code', () => {
  it('Ablauf: Code anfordern, prüfen, Sitzung mit Methode code und Passkey-Angebot', async () => {
    const res = await loginByCode('anna@kunde.at')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, passkeyOffer: true })
    expect(res.cookie).toBeTruthy()
    expect(sent[0]!.headers['X-Aimarage-Template']).toBe('login-code')
    const me = await call('GET', '/api/me', { cookie: res.cookie! })
    expect(me.body.user.email).toBe('Anna@Kunde.at')
    expect(me.body.auth.password).toBe(true)
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, tokenHash(res.cookie!)))
    expect(s!.method).toBe('code')
    expect(s!.userAgent).toContain('Firefox')
    expect(s!.stepUpAt).not.toBeNull()
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, anna))
    expect(u!.emailVerifiedAt).not.toBeNull()
    const [row] = await db.select().from(schema.authCodes).where(eq(schema.authCodes.target, 'anna@kunde.at'))
    expect(row!.codeHash).not.toContain(lastCode())
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('unbekannte Adresse im Kern: gleiche Antwort, keine Mail, kein Login', async () => {
    const known = await call('POST', '/api/auth/code/request', { body: { email: 'anna@kunde.at' }, ip: freshIp() })
    const unknown = await call('POST', '/api/auth/code/request', { body: { email: 'niemand@kunde.at' }, ip: freshIp() })
    expect(unknown.status).toBe(known.status)
    expect(unknown.body).toEqual(known.body)
    expect(sent.map(m => m.to)).toEqual(['anna@kunde.at'])
    const v = await call('POST', '/api/auth/code/verify', { body: { email: 'niemand@kunde.at', code: '123456' }, ip: freshIp() })
    expect(v.status).toBe(400)
    expect(v.cookie).toBeNull()
  })

  it('unbekannte Adresse gehostet: Code, danach needsSignup mit signiertem Token und Hook', async () => {
    process.env.HOSTED = 'true'
    const seen: string[] = []
    registerExtension({ name: 'test', onSignupVerified: async (_db, i) => { seen.push(i.email) } })
    const ip = freshIp()
    expect((await call('POST', '/api/auth/code/request', { body: { email: 'Neu@Firma.at' }, ip })).body).toEqual({ ok: true })
    const v = await call('POST', '/api/auth/code/verify', { body: { email: 'neu@firma.at', code: lastCode('neu@firma.at') }, ip })
    expect(v.status).toBe(200)
    expect(v.body.needsSignup).toBe(true)
    expect(v.cookie).toBeNull()
    expect(seen).toEqual(['neu@firma.at'])
    expect(readRegistrationToken(v.body.signupToken)).toBe('neu@firma.at')
    expect(readRegistrationToken(`${v.body.signupToken}x`)).toBeNull()
    expect(readRegistrationToken(v.body.signupToken, new Date(Date.now() + 31 * 60_000))).toBeNull()
    const forged = `${Buffer.from(JSON.stringify({ e: 'boss@firma.at', x: Date.now() + 1e6 })).toString('base64url')}.${v.body.signupToken.split('.')[1]}`
    expect(readRegistrationToken(forged)).toBeNull()
    expect(readRegistrationToken(issueRegistrationToken('a@b.at'))).toBe('a@b.at')
  })

  it('Ablaufzeit: nach 10 Minuten gilt der Code nicht mehr', async () => {
    const ip = freshIp()
    await call('POST', '/api/auth/code/request', { body: { email: 'anna@kunde.at' }, ip })
    const code = lastCode()
    shiftNow(11)
    const v = await call('POST', '/api/auth/code/verify', { body: { email: 'anna@kunde.at', code }, ip })
    expect(v.status).toBe(400)
    expect(v.body.statusMessage).toMatch(/abgelaufen/)
  })

  it('Versuche: nach 5 falschen ist der Code verbraucht, auch der richtige geht dann nicht', async () => {
    const ip = freshIp()
    await call('POST', '/api/auth/code/request', { body: { email: 'anna@kunde.at' }, ip })
    const code = lastCode()
    const wrong = code === '000000' ? '111111' : '000000'
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await call('POST', '/api/auth/code/verify', { body: { email: 'anna@kunde.at', code: wrong }, ip })).status)
    expect(statuses).toEqual([400, 400, 400, 400, 429])
    expect((await call('POST', '/api/auth/code/verify', { body: { email: 'anna@kunde.at', code }, ip })).status).toBe(400)
  })

  it('Versuche atomar: parallele falsche Eingaben zählen alle', async () => {
    const ip = freshIp()
    await call('POST', '/api/auth/code/request', { body: { email: 'anna@kunde.at' }, ip })
    const code = lastCode()
    const wrong = code === '000000' ? '111111' : '000000'
    await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/auth/code/verify', { body: { email: 'anna@kunde.at', code: wrong }, ip })))
    const [row] = await db.select().from(schema.authCodes).where(eq(schema.authCodes.target, 'anna@kunde.at')).orderBy(schema.authCodes.createdAt)
    const rows = await db.select().from(schema.authCodes).where(eq(schema.authCodes.target, 'anna@kunde.at'))
    const latest = rows.sort((a, b) => +b.createdAt - +a.createdAt)[0]!
    expect(row).toBeTruthy()
    expect(latest.attempts).toBe(5)
    expect(latest.consumedAt).not.toBeNull()
  })

  it('Wiederverwendung: ein Code gilt nur einmal, ein neuer Code entwertet den alten', async () => {
    const ip = freshIp()
    await call('POST', '/api/auth/code/request', { body: { email: 'anna@kunde.at' }, ip })
    const first = lastCode()
    await call('POST', '/api/auth/code/request', { body: { email: 'anna@kunde.at' }, ip })
    const second = lastCode()
    if (first !== second) expect((await call('POST', '/api/auth/code/verify', { body: { email: 'anna@kunde.at', code: first }, ip })).status).toBe(400)
    expect((await call('POST', '/api/auth/code/verify', { body: { email: 'anna@kunde.at', code: second }, ip })).status).toBe(200)
    expect((await call('POST', '/api/auth/code/verify', { body: { email: 'anna@kunde.at', code: second }, ip })).status).toBe(400)
  })

  it('Grenzen: 5 Anforderungen je Adresse in 15 Minuten, 30 je IP pro Stunde', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/auth/code/request', { body: { email: 'anna@kunde.at' }, ip: freshIp() })).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
    shiftNow(16)
    expect((await call('POST', '/api/auth/code/request', { body: { email: 'anna@kunde.at' }, ip: freshIp() })).status).toBe(200)
    delete process.env.MA_NOW
    const ip = freshIp()
    const perIp: number[] = []
    for (let i = 0; i < 31; i++) perIp.push((await call('POST', '/api/auth/code/request', { body: { email: `x${i}@kunde.at` }, ip })).status)
    expect(perIp.filter(s => s === 200)).toHaveLength(30)
    expect(perIp[30]).toBe(429)
  })

  it('Grenzen: 60 Prüfungen je IP pro Stunde, 10 Fehlversuche je Adresse pro Stunde', async () => {
    const ip = freshIp()
    const res: number[] = []
    for (let i = 0; i < 61; i++) res.push((await call('POST', '/api/auth/code/verify', { body: { email: `y${i}@kunde.at`, code: '123456' }, ip })).status)
    expect(res.slice(0, 60).every(s => s === 400)).toBe(true)
    expect(res[60]).toBe(429)
    const fails: number[] = []
    for (let round = 0; round < 3; round++) {
      await call('POST', '/api/auth/code/request', { body: { email: 'bert@kunde.at' }, ip: freshIp() })
      const code = lastCode('bert@kunde.at')
      const wrong = code === '000000' ? '111111' : '000000'
      for (let i = 0; i < 4; i++) fails.push((await call('POST', '/api/auth/code/verify', { body: { email: 'bert@kunde.at', code: wrong }, ip: freshIp() })).status)
    }
    expect(fails.slice(0, 10).every(s => s === 400)).toBe(true)
    expect(fails[10]).toBe(429)
  })

  it('Passwort-Login nur mit AUTH_PASSWORD, gehostet standardmäßig aus', async () => {
    expect((await call('POST', '/api/auth/login', { body: { email: 'anna@kunde.at', password: 'falsch' }, ip: freshIp() })).status).toBe(401)
    process.env.HOSTED = 'true'
    expect((await call('POST', '/api/auth/login', { body: { email: 'anna@kunde.at', password: 'falsch' }, ip: freshIp() })).status).toBe(404)
    expect((await call('GET', '/api/auth/config')).body).toMatchObject({ password: false, hosted: true })
    process.env.AUTH_PASSWORD = 'true'
    expect((await call('POST', '/api/auth/login', { body: { email: 'anna@kunde.at', password: 'falsch' }, ip: freshIp() })).status).toBe(401)
    process.env.HOSTED = ''
    process.env.AUTH_PASSWORD = 'false'
    expect((await call('POST', '/api/auth/login', { body: { email: 'anna@kunde.at', password: 'falsch' }, ip: freshIp() })).status).toBe(404)
  })
})

describe('Step-up und E-Mail-Wechsel', () => {
  it('heikle Aktion ohne frische Bestätigung ergibt 403, nach Code-Bestätigung geht sie', async () => {
    const cookie = await oldSession(anna)
    const [pk] = await db.insert(schema.passkeys).values({ userId: anna, credentialId: 'cred-step', publicKey: 'AQID', name: 'Alt' }).returning()
    const denied = await call('DELETE', `/api/me/passkeys/${pk!.id}`, { cookie })
    expect(denied.status).toBe(403)
    expect(denied.body.data).toEqual({ stepUp: true })
    expect((await call('POST', '/api/auth/step-up', { cookie, body: { method: 'code-request' } })).status).toBe(200)
    expect(sent.at(-1)!.headers['X-Aimarage-Template']).toBe('step-up')
    expect((await call('POST', '/api/auth/step-up', { cookie, body: { method: 'code', code: lastCode() === '000000' ? '111111' : '000000' } })).status).toBe(400)
    expect((await call('POST', '/api/auth/step-up', { cookie, body: { method: 'code', code: lastCode() } })).status).toBe(200)
    expect((await db.select().from(schema.sessions).where(eq(schema.sessions.id, tokenHash(cookie))))[0]!.method).toBe('password')
    expect((await call('DELETE', `/api/me/passkeys/${pk!.id}`, { cookie })).status).toBe(200)
    shiftNow(11)
    const [pk2] = await db.insert(schema.passkeys).values({ userId: anna, credentialId: 'cred-step2', publicKey: 'AQID', name: 'Alt2' }).returning()
    expect((await call('DELETE', `/api/me/passkeys/${pk2!.id}`, { cookie })).status).toBe(403)
    await db.delete(schema.passkeys).where(eq(schema.passkeys.id, pk2!.id))
  })

  it('Step-up per Passwort nur mit AUTH_PASSWORD', async () => {
    const { hashPassword } = await import('../../server/lib/auth')
    await db.update(schema.users).set({ passwordHash: await hashPassword('geheim123') }).where(eq(schema.users.id, anna))
    const cookie = await oldSession(anna)
    expect((await call('POST', '/api/auth/step-up', { cookie, body: { method: 'password', password: 'falsch' } })).status).toBe(400)
    expect((await call('POST', '/api/auth/step-up', { cookie, body: { method: 'password', password: 'geheim123' } })).status).toBe(200)
    process.env.AUTH_PASSWORD = 'false'
    expect((await call('POST', '/api/auth/step-up', { cookie, body: { method: 'password', password: 'geheim123' } })).status).toBe(404)
    await db.update(schema.users).set({ passwordHash: null }).where(eq(schema.users.id, anna))
  })

  it('E-Mail-Wechsel: braucht Bestätigung, Code an neue Adresse, Hinweis an alte, belegte Adresse abgelehnt', async () => {
    const cookie = await oldSession(anna)
    expect((await call('POST', '/api/me/email/request', { cookie, body: { email: 'anna.neu@kunde.at' } })).status).toBe(403)
    await call('POST', '/api/auth/step-up', { cookie, body: { method: 'code-request' } })
    await call('POST', '/api/auth/step-up', { cookie, body: { method: 'code', code: lastCode() } })
    expect((await call('POST', '/api/me/email/request', { cookie, body: { email: 'bert@kunde.at' } })).status).toBe(409)
    expect((await call('POST', '/api/me/email/request', { cookie, body: { email: 'Anna.Neu@Kunde.at' } })).status).toBe(200)
    const mail = sent.at(-1)!
    expect(mail.to).toBe('anna.neu@kunde.at')
    expect(mail.headers['X-Aimarage-Template']).toBe('email-change')
    const bertCookie = await oldSession((await db.select().from(schema.users).where(eq(schema.users.email, 'bert@kunde.at')))[0]!.id)
    expect((await call('POST', '/api/me/email/verify', { cookie: bertCookie, body: { email: 'anna.neu@kunde.at', code: lastCode() } })).status).toBe(400)
    const ok = await call('POST', '/api/me/email/verify', { cookie, body: { email: 'anna.neu@kunde.at', code: lastCode() } })
    expect(ok.status).toBe(200)
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, anna))
    expect(u!.email).toBe('anna.neu@kunde.at')
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'system_mail'))
    expect(jobs.some(j => (j.payload as { to?: string }).to === 'Anna@Kunde.at')).toBe(true)
    expect((await call('PATCH', '/api/me', { cookie, body: { email: 'x@y.at' } })).status).toBe(200)
    expect((await db.select().from(schema.users).where(eq(schema.users.id, anna)))[0]!.email).toBe('anna.neu@kunde.at')
    await db.update(schema.users).set({ email: 'anna@kunde.at' }).where(eq(schema.users.id, anna))
  })
})

describe('Passkeys', () => {
  it('registrieren und anmelden mit gemockter simplewebauthn, Zähler steigt, Challenge nur einmal', async () => {
    const login = await loginByCode('anna@kunde.at')
    const cookie = login.cookie!
    const opts = await call('POST', '/api/auth/passkey/register/options', { cookie })
    expect(opts.status).toBe(200)
    expect(opts.body.options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' })
    expect(opts.body.options.rp.id).toBe('localhost')
    const reg = await call('POST', '/api/auth/passkey/register/verify', { cookie, body: { challengeId: opts.body.challengeId, name: 'Firefox auf Mac', response: { id: 'cred-anna', response: { clientDataJSON: opts.body.options.challenge } } } })
    expect(reg.status).toBe(200)
    expect(wa.calls.at(-1)).toMatchObject({ expectedOrigin: 'http://localhost:3210', expectedRPID: 'localhost', requireUserVerification: true })
    const again = await call('POST', '/api/auth/passkey/register/verify', { cookie, body: { challengeId: opts.body.challengeId, response: { id: 'cred-x', response: { clientDataJSON: opts.body.options.challenge } } } })
    expect(again.status).toBe(400)
    const list = await call('GET', '/api/me/passkeys', { cookie })
    expect(list.body.passkeys.map((p: { name: string }) => p.name)).toEqual(['Firefox auf Mac'])

    const lo = await call('POST', '/api/auth/passkey/login/options', { ip: freshIp() })
    expect(lo.body.options.userVerification).toBe('required')
    const bad = await call('POST', '/api/auth/passkey/login/verify', { body: { challengeId: lo.body.challengeId, response: { id: 'cred-anna', response: { clientDataJSON: 'falsch' } } } })
    expect(bad.status).toBe(400)
    const lo2 = await call('POST', '/api/auth/passkey/login/options', { ip: freshIp() })
    const ok = await call('POST', '/api/auth/passkey/login/verify', { body: { challengeId: lo2.body.challengeId, response: { id: 'cred-anna', response: { clientDataJSON: lo2.body.options.challenge } } } })
    expect(ok.status).toBe(200)
    expect(ok.cookie).toBeTruthy()
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, tokenHash(ok.cookie!)))
    expect(s!.method).toBe('passkey')
    const [pk] = await db.select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, 'cred-anna'))
    expect(pk!.counter).toBe(1)
    expect(pk!.lastUsedAt).not.toBeNull()
    const reuse = await call('POST', '/api/auth/passkey/login/verify', { body: { challengeId: lo2.body.challengeId, response: { id: 'cred-anna', response: { clientDataJSON: lo2.body.options.challenge } } } })
    expect(reuse.status).toBe(400)

    const lo3 = await call('POST', '/api/auth/passkey/login/options', { ip: freshIp() })
    shiftNow(6)
    const late = await call('POST', '/api/auth/passkey/login/verify', { body: { challengeId: lo3.body.challengeId, response: { id: 'cred-anna', response: { clientDataJSON: lo3.body.options.challenge } } } })
    expect(late.status).toBe(400)
    delete process.env.MA_NOW

    const again2 = await loginByCode('anna@kunde.at')
    expect(again2.body.passkeyOffer).toBe(false)
  })

  it('Step-up mit Passkey: fremder Passkey wird abgelehnt', async () => {
    const [bert] = await db.select().from(schema.users).where(eq(schema.users.email, 'bert@kunde.at'))
    await db.insert(schema.passkeys).values({ userId: bert!.id, credentialId: 'cred-bert', publicKey: 'AQID', name: 'Bert' })
    const cookie = await oldSession(anna)
    const o = await call('POST', '/api/auth/step-up', { cookie, body: { method: 'passkey-options' } })
    expect(o.status).toBe(200)
    expect(o.body.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual(['cred-anna'])
    const foreign = await call('POST', '/api/auth/step-up', { cookie, body: { method: 'passkey', challengeId: o.body.challengeId, response: { id: 'cred-bert', response: { clientDataJSON: o.body.options.challenge } } } })
    expect(foreign.status).toBe(401)
    expect((await db.select().from(schema.sessions).where(eq(schema.sessions.id, tokenHash(cookie))))[0]!.method).toBe('password')
    const o2 = await call('POST', '/api/auth/step-up', { cookie, body: { method: 'passkey-options' } })
    const own = await call('POST', '/api/auth/step-up', { cookie, body: { method: 'passkey', challengeId: o2.body.challengeId, response: { id: 'cred-anna', response: { clientDataJSON: o2.body.options.challenge } } } })
    expect(own.status).toBe(200)
    expect((await db.select().from(schema.sessions).where(eq(schema.sessions.id, tokenHash(cookie))))[0]!.method).toBe('passkey')
    const pkB = (await db.select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, 'cred-bert')))[0]!
    expect((await call('DELETE', `/api/me/passkeys/${pkB.id}`, { cookie })).status).toBe(404)
    expect((await call('PATCH', `/api/me/passkeys/${pkB.id}`, { cookie, body: { name: 'x' } })).status).toBe(404)
  })

  it('Später: Passkey-Angebot ruht 30 Tage', async () => {
    const [carl] = await db.insert(schema.users).values({ email: 'carl@kunde.at', name: 'Carl' }).returning()
    await db.insert(schema.memberships).values({ workspaceId: ws, userId: carl!.id, role: 'member' })
    const first = await loginByCode('carl@kunde.at')
    expect(first.body.passkeyOffer).toBe(true)
    expect((await call('GET', '/api/me', { cookie: first.cookie! })).body.user.passkeyOffer).toBe(true)
    expect((await call('POST', '/api/me/passkey-prompt', { cookie: first.cookie! })).status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: first.cookie! })).body.user.passkeyOffer).toBe(false)
    expect((await loginByCode('carl@kunde.at')).body.passkeyOffer).toBe(false)
    shiftNow(31 * 24 * 60)
    expect((await loginByCode('carl@kunde.at')).body.passkeyOffer).toBe(true)
  })
})

describe('Sitzungen und Workspace-Wechsel', () => {
  it('Liste, einzelne abmelden, alle anderen abmelden', async () => {
    const a = (await loginByCode('anna@kunde.at')).cookie!
    const b = (await loginByCode('anna@kunde.at')).cookie!
    const list = await call('GET', '/api/me/sessions', { cookie: a })
    const ids = list.body.sessions.map((s: { id: string }) => s.id)
    expect(ids).toContain(tokenHash(b))
    expect(list.body.sessions.find((s: { current: boolean }) => s.current).id).toBe(tokenHash(a))
    expect((await call('DELETE', `/api/me/sessions/${tokenHash(b)}`, { cookie: a })).status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: b })).body.user).toBeNull()
    const c = (await loginByCode('anna@kunde.at')).cookie!
    const [bert] = await db.select().from(schema.users).where(eq(schema.users.email, 'bert@kunde.at'))
    const bertCookie = await oldSession(bert!.id)
    expect((await call('DELETE', `/api/me/sessions/${tokenHash(bertCookie)}`, { cookie: a })).status).toBe(404)
    expect((await call('DELETE', '/api/me/sessions/others', { cookie: a })).status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: c })).body.user).toBeNull()
    expect((await call('GET', '/api/me', { cookie: a })).body.user.name).toBe('Anna')
    expect((await call('GET', '/api/me', { cookie: bertCookie })).body.user.name).toBe('Bert')
  })

  it('Workspace-Wechsel: neue Sitzung, alte ungültig, fremder Workspace 404', async () => {
    const cookie = await oldSession(anna)
    const res = await call('POST', '/api/auth/workspace', { cookie, body: { workspaceId: ws2 } })
    expect(res.status).toBe(200)
    expect(res.cookie).toBeTruthy()
    expect((await call('GET', '/api/me', { cookie })).body.user).toBeNull()
    const me = await call('GET', '/api/me', { cookie: res.cookie! })
    expect(me.body.workspace.id).toBe(ws2)
    expect(me.body.workspaces.map((w: { id: string }) => w.id)).toEqual([ws, ws2])
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, tokenHash(res.cookie!)))
    expect(s!.stepUpAt).toBeNull()
    const [other] = await db.insert(schema.workspaces).values({ name: 'Fremd' }).returning()
    expect((await call('POST', '/api/auth/workspace', { cookie: res.cookie!, body: { workspaceId: other!.id } })).status).toBe(404)
  })
})
