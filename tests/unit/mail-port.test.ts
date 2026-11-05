import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { ALREADY_SENT, buildMailSettings, checkMail, MailError, sendDraft, sentInfo, SMTP_UNREACHABLE } from '../../server/lib/mail'
import { applyDraftAction, DraftStateError } from '../../server/services/drafts'
import { mailServerUnreachable } from '../../server/lib/mailer'
import { resetSecretCache } from '../../server/lib/secret'

const smtp = vi.hoisted(() => ({ opts: [] as Record<string, unknown>[], blocked: new Set<number>([465]), refused: false, sent: 0 }))

vi.mock('nodemailer', () => {
  const fail = (port: number) => {
    if (!smtp.blocked.has(port)) return null
    return smtp.refused
      ? Object.assign(new Error(`connect ECONNREFUSED 1.2.3.4:${port}`), { code: 'ESOCKET', command: 'CONN' })
      : Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' })
  }
  return {
    default: {
      createTransport(o: Record<string, unknown>) {
        smtp.opts.push(o)
        const port = o.port as number
        return {
          async verify() {
            const e = fail(port)
            if (e) throw e
            return true
          },
          async sendMail() {
            const e = fail(port)
            if (e) throw e
            smtp.sent++
            return { messageId: 'x' }
          },
          close() {},
        }
      },
    },
  }
})

vi.mock('imapflow', () => ({
  ImapFlow: class {
    async connect() {}
    async logout() {}
    async list() {
      return []
    }
  },
}))

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let ownerId: string

async function setPort(port: number, secure: boolean) {
  const mail = buildMailSettings(ws.id, project.id, null, { imapHost: 'mail.test', imapPort: 993, imapSecure: true, smtpHost: 'mail.test', smtpPort: port, smtpSecure: secure, user: 'p@visitors.example', from: 'The Wanderer <p@visitors.example>', imapPassword: 'geheim' })
  await db.update(schema.projects).set({ setup: { mail } }).where(eq(schema.projects.id, project.id))
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}

let seq = 0
async function mailDraft() {
  const n = ++seq
  const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `V-${n}`, title: `Antwort ${n}`, description: 'Der Blog bittet um Einsendungen per Mail: https://blog.example/submit', category: 'outreach', status: 'entwurf_fertig', draftKind: 'mail' }).returning()
  const [draft] = await db.insert(schema.drafts).values({ taskId: task!.id, kind: 'mail', subject: 'Hallo', body: 'Hallo Anna', recipient: 'anna@blog.example' }).returning()
  return draft!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { sendLive: true } }).returning())[0]!
  ownerId = (await db.insert(schema.users).values({ email: 'p@test.local', name: 'Peter' }).returning())[0]!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: ownerId, role: 'owner' })
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'visitors', name: 'The Wanderer', code: 'VIS', icon: 'music' }).returning())[0]!
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})
beforeEach(() => {
  smtp.opts.length = 0
  smtp.blocked = new Set([465])
  smtp.refused = false
  smtp.sent = 0
})

const switches = async () => db.select().from(schema.activity).where(and(eq(schema.activity.projectId, project.id), eq(schema.activity.action, 'mailbox_port_switched')))

describe('Versand-Port 465 gesperrt', () => {
  it('erkennt Zeitüberschreitung und abgelehnte Verbindung, nicht aber Anmeldefehler', () => {
    expect(mailServerUnreachable(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }))).toBe(true)
    expect(mailServerUnreachable(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:465'), { code: 'ESOCKET' }))).toBe(true)
    expect(mailServerUnreachable(Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH' }))).toBe(false)
    expect(mailServerUnreachable(null)).toBe(false)
  })

  it('Senden fällt auf 587 mit STARTTLS zurück und schreibt die Konfiguration um', async () => {
    await setPort(465, true)
    const draft = await mailDraft()
    expect((await sendDraft(db, ws, { draftId: draft.id, userId: ownerId, mode: 'manual' })).status).toBe('gesendet')
    expect(smtp.opts.map(o => [o.port, o.secure, o.requireTLS])).toEqual([[465, true, false], [587, false, true]])
    expect(smtp.sent).toBe(1)
    const fresh = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
    expect(fresh.setup.mail!.smtp).toMatchObject({ host: 'mail.test', port: 587, secure: false, user: 'p@visitors.example' })
    const log = await switches()
    expect(log).toHaveLength(1)
    expect(log[0]!.detail).toMatchObject({ title: 'The Wanderer', from: 465, to: 587 })
    expect(log[0]!.userId).toBe(ownerId)

    project = fresh
    smtp.opts.length = 0
    const next = await mailDraft()
    await sendDraft(db, ws, { draftId: next.id, userId: ownerId, mode: 'manual' })
    expect(smtp.opts.map(o => o.port)).toEqual([587])
  })

  it('Prüfen beim Speichern: ECONNREFUSED auf 465, 587 klappt, umgestellt ohne Fehler', async () => {
    await setPort(465, true)
    smtp.refused = true
    const r = await checkMail(db, ws, project, undefined, ownerId)
    expect(r).toEqual({ imap: null, smtp: null, switched: true })
    const fresh = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
    expect(fresh.setup.mail!.smtp).toMatchObject({ port: 587, secure: false })
    expect(fresh.setup.mail!.error).toBeNull()
  })

  it('auch 587 nicht erreichbar: klare Meldung, Konfiguration bleibt', async () => {
    await setPort(465, true)
    smtp.blocked = new Set([465, 587])
    const before = (await switches()).length
    const draft = await mailDraft()
    const err = await sendDraft(db, ws, { draftId: draft.id, userId: ownerId, mode: 'manual' }).catch(e => e)
    expect(err).toBeInstanceOf(MailError)
    expect(err.message).toBe(`Senden fehlgeschlagen: ${SMTP_UNREACHABLE}`)
    expect(err.code).toBe('smtp_unreachable')
    const check = await checkMail(db, ws, project)
    expect(check.smtp).toBe(`SMTP: ${SMTP_UNREACHABLE}`)
    const fresh = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
    expect(fresh.setup.mail!.smtp).toMatchObject({ port: 465, secure: true })
    expect(await switches()).toHaveLength(before)
  })

  it('kein Rückfall bei anderen Ports', async () => {
    await setPort(587, false)
    smtp.blocked = new Set([587])
    const r = await checkMail(db, ws, project)
    expect(r.smtp).toBe(`SMTP: ${SMTP_UNREACHABLE}`)
    expect(smtp.opts.map(o => o.port)).toEqual([587])
  })
})

describe('Schon gesendet', () => {
  it('kein doppeltes Senden derselben Fassung, Erneut senden nur mit Flag und im Verlauf', async () => {
    await setPort(587, false)
    smtp.blocked = new Set()
    const draft = await mailDraft()
    await sendDraft(db, ws, { draftId: draft.id, userId: ownerId, mode: 'manual' })
    expect(await sentInfo(db, draft.id)).toMatchObject({ to: 'anna@blog.example' })
    const err = await sendDraft(db, ws, { draftId: draft.id, userId: ownerId, mode: 'manual' }).catch(e => e)
    expect(err).toBeInstanceOf(MailError)
    expect(err.message).toBe(ALREADY_SENT)
    expect(err.code).toBe('already_sent')
    expect(smtp.sent).toBe(1)
    await expect(applyDraftAction(db, ws, ownerId, draft.id, 'posted')).rejects.toThrow(DraftStateError)
    expect((await sendDraft(db, ws, { draftId: draft.id, userId: ownerId, mode: 'manual', resend: true })).status).toBe('gesendet')
    expect(smtp.sent).toBe(2)
    const log = await db.select().from(schema.activity).where(and(eq(schema.activity.projectId, project.id), eq(schema.activity.action, 'mail_resent')))
    expect(log).toHaveLength(1)
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, draft.taskId))
    expect(task!.status).toBe('wartet')
  })
})
