import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { queueSystemMail, sendSystemMail, setSystemMailTransport, SystemMailError, systemMailRoute, type SystemMailMessage } from '../../server/lib/system-mail'
import { runOnce } from '../../server/lib/worker'
import { renderSystemMail, SYSTEM_MAIL_TEMPLATES } from '../../server/mail-templates'

let db: Db
let close: () => Promise<void>
let mailbox: string
const ENV = ['SMTP_URL', 'MAIL_FROM', 'MAIL_REPLY_TO', 'DEV_MAILBOX', 'DEV_MAILBOX_DIR']

function fakeTransport(fail = 0) {
  const sent: SystemMailMessage[] = []
  let left = fail
  setSystemMailTransport({
    async sendMail(msg) {
      if (left > 0) {
        left--
        throw new Error('421 try again later')
      }
      sent.push(msg)
    },
  })
  return sent
}

beforeAll(async () => {
  ;({ db, close } = await openTestDb())
  mailbox = await mkdtemp(join(tmpdir(), 'ma-mailbox-'))
})

afterEach(() => {
  setSystemMailTransport(null)
  for (const k of ENV) delete process.env[k]
  vi.restoreAllMocks()
})

afterAll(async () => {
  await close()
  await rm(mailbox, { recursive: true, force: true })
})

describe('Vorlagen', () => {
  it('rendert alle Vorlagen in de und en mit Text und HTML', () => {
    const vars = { code: '123456', email: 'neu@firma.at', subject: 'Hinweis', body: 'Zeile 1\n\nZeile 2', sender: 'Agentur', project: 'Projekt', url: 'https://app.aimarage.test/k/akl_x' }
    for (const t of SYSTEM_MAIL_TEMPLATES) {
      for (const loc of ['de', 'en']) {
        const r = renderSystemMail(t, vars as never, loc)
        expect(r.subject.length).toBeGreaterThan(3)
        expect(r.text).toContain('Aimarage')
        expect(r.html).toContain('<html lang="' + loc + '"')
        expect(r.html).not.toMatch(/<img/i)
      }
    }
    expect(renderSystemMail('login-code', { code: '987654' }, 'en').text).toContain('987654')
    expect(renderSystemMail('login-code', { code: '987654' }, 'de-AT').subject).toContain('Anmeldecode')
  })

  it('maskiert HTML in Variablen', () => {
    const r = renderSystemMail('generic-notice', { subject: 'x', body: '<script>alert(1)</script>', actionUrl: 'javascript:alert(1)' }, 'de')
    expect(r.html).not.toContain('<script>')
    expect(r.html).toContain('&lt;script&gt;')
    expect(r.html).not.toContain('javascript:')
  })
})

describe('Versandweg', () => {
  it('schickt Testadressen nie über SMTP', () => {
    for (const to of ['a@b.local', 'x@example.com', 'y@firma.test', 'z@sub.example.org']) expect(systemMailRoute(to, { smtp: true, devMailbox: false })).toEqual({ smtp: false, mailbox: false, log: true })
    expect(systemMailRoute('peter@firma.at', { smtp: true, devMailbox: false }).smtp).toBe(true)
    expect(systemMailRoute('peter@firma.at', { smtp: false, devMailbox: false }).log).toBe(true)
    expect(systemMailRoute('peter@firma.at', { smtp: false, devMailbox: true })).toEqual({ smtp: false, mailbox: true, log: false })
  })

  it('sendet über SMTP mit Absender und Antwortadresse', async () => {
    process.env.MAIL_REPLY_TO = 'mail@aimarage.com'
    process.env.MAIL_FROM = 'Aimarage <noreply@aimarage.com>'
    const sent = fakeTransport()
    expect(await sendSystemMail('peter@firma.at', 'login-code', { code: '424242' }, 'de')).toBe('smtp')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.from).toBe('Aimarage <noreply@aimarage.com>')
    expect(sent[0]!.replyTo).toBe('mail@aimarage.com')
    expect(sent[0]!.text).toContain('424242')
    expect(sent[0]!.html).toContain('424242')
  })

  it('schreibt ohne SMTP ins Log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await sendSystemMail('peter@firma.at', 'step-up', { code: '111222' }, 'en')).toBe('log')
    expect(log.mock.calls.flat().join('\n')).toContain('111222')
  })

  it('legt Mails im Dev-Postfach ab und lässt Testadressen weg von SMTP', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.DEV_MAILBOX = 'true'
    process.env.DEV_MAILBOX_DIR = mailbox
    const sent = fakeTransport()
    expect(await sendSystemMail('owner@aimarage.test', 'email-change', { code: '555666', email: 'neu@aimarage.test' }, 'de')).toBe('dev-mailbox')
    expect(sent).toHaveLength(0)
    const files = await readdir(mailbox)
    expect(files).toHaveLength(1)
    const stored = JSON.parse(await readFile(join(mailbox, files[0]!), 'utf8'))
    expect(stored.to).toBe('owner@aimarage.test')
    expect(stored.text).toContain('555666')
  })

  it('lehnt ungültige Adressen ab', async () => {
    await expect(sendSystemMail('kein-at', 'login-code', { code: '1' }, 'de')).rejects.toBeInstanceOf(SystemMailError)
    await expect(sendSystemMail('a@b.at\nBcc: x@y.at', 'login-code', { code: '1' }, 'de')).rejects.toBeInstanceOf(SystemMailError)
  })
})

describe('Job system_mail', () => {
  it('wiederholt nach einem SMTP-Fehler und sendet dann', async () => {
    const sent = fakeTransport(1)
    expect(await queueSystemMail(db, 'peter@firma.at', 'generic-notice', { subject: 'Hallo', body: 'Text' }, 'de')).toBe(true)
    expect(await runOnce(db, 'test')).toBe(true)
    let [job] = await db.select().from(schema.jobs)
    expect(job!.status).toBe('queued')
    expect(job!.lastError).toContain('421')
    await db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) })
    expect(await runOnce(db, 'test')).toBe(true)
    ;[job] = await db.select().from(schema.jobs)
    expect(job!.status).toBe('done')
    expect(job!.maxAttempts).toBe(5)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toBe('Hallo')
  })
})
