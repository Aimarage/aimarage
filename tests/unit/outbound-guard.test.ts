import { and, eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDraftTask } from '../../server/lib/agent'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { buildMailSettings, sendDraft, syncProjectMail } from '../../server/lib/mail'
import { pickSentFolder, type MailBackend, type OutMessage } from '../../server/lib/mailer'
import { resetSecretCache } from '../../server/lib/secret'
import { detectLang, expectedLangs, internalTextProblems, languageProblem, outboundProblems } from '../../shared/utils/outbound-guard'

const INCIDENT = 'Kein Versand: THE-PFL-007 wird nicht bearbeitet. Mr Mello\'s LoFi Beats erhält laut Projektregel höchstens eine Antwort (THE-PFL-003 ist erfolgt).'
const GOOD = 'Hi Bobby,\n\nthanks for getting back to us and for the link to your playlists. We totally get that the radio is chill lofi only, so no pressure at all. Have a great week!\n\nJack, Jill & Joe'

describe('Wächter vor dem Senden', () => {
  it('erkennt interne Notizen (Vorfall THE-PFL-007)', () => {
    expect(internalTextProblems([INCIDENT])[0]).toMatch(/interne[rn]? Notiz.*THE-PFL-007/)
    expect(internalTextProblems(['Re: x', 'Nicht senden. Bitte die Aufgabe schließen.'])).toHaveLength(1)
    expect(internalTextProblems(['Do not send: the contact only wants one reply per project rule.'])).toHaveLength(1)
    expect(internalTextProblems([GOOD])).toEqual([])
    expect(internalTextProblems(['Superposition is out: twelve new tracks. ISO-IEC-27001 certified hosting in Berlin.'])).toEqual([])
    expect(internalTextProblems(['Kein Abo, keine Werbung: Linkbox gibt es seit 2003.'])).toEqual([])
  })
  it('erkennt die Sprache und meldet Deutsch an englischen Kontakt', () => {
    expect(detectLang(INCIDENT)).toBe('de')
    expect(detectLang(GOOD)).toBe('en')
    expect(detectLang('ok')).toBeNull()
    expect(languageProblem(INCIDENT, ['en'])).toMatch(/Deutsch, erwartet Englisch/)
    expect(languageProblem(GOOD, ['en'])).toBeNull()
    expect(languageProblem(INCIDENT, ['de', 'en'])).toBeNull()
    expect(expectedLangs({ language: 'de' }, { languages: ['de'] }, 'Hey Triple J! Good to hear from you and thanks for introducing yourselves! We usually do not add music sent by email.')).toEqual(['en'])
    expect(expectedLangs({ language: null }, { languages: ['de', 'en'] })).toEqual(['de', 'en'])
    expect(outboundProblems([INCIDENT], ['en'])).toHaveLength(2)
  })
  it('findet den Gesendet-Ordner', () => {
    expect(pickSentFolder([{ path: 'INBOX', name: 'INBOX' }, { path: 'Gesendete Elemente', name: 'Gesendete Elemente', specialUse: '\\Sent' }])).toBe('Gesendete Elemente')
    expect(pickSentFolder([{ path: 'INBOX', name: 'INBOX' }, { path: 'INBOX.Sent', name: 'Sent' }])).toBe('INBOX.Sent')
    expect(pickSentFolder([{ path: 'INBOX', name: 'INBOX' }, { path: 'Gesendet', name: 'Gesendet' }])).toBe('Gesendet')
    expect(pickSentFolder([{ path: 'INBOX', name: 'INBOX' }, { path: 'Archiv', name: 'Archiv' }])).toBeNull()
  })
})

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let ownerId: string
let seq = 0

function backend(inbox: { uid: number, raw: string }[], appendFails = false) {
  const sent: OutMessage[] = []
  const appended: string[] = []
  const b: MailBackend = {
    async verifyImap() {},
    async verifySmtp() {},
    async fetchNew(_c, _p, since) {
      return { uidValidity: '7', messages: inbox.filter(m => !since.uid || m.uid > since.uid).map(m => ({ uid: m.uid, source: Buffer.from(m.raw) })) }
    },
    async send(_c, _p, msg) {
      sent.push(msg)
      return { messageId: `<out-${++seq}@thewanderer.example>`, raw: Buffer.from(`raw:${msg.text}`) }
    },
    async appendSent(_c, _p, raw) {
      if (appendFails) throw new Error('IMAP weg')
      appended.push(raw.toString())
    },
    async markSeen() {},
  }
  return { b, sent, appended }
}

const raw = (o: { uid: number, body: string, inReplyTo: string, subject: string }) => [
  'From: Mr Mello\'s LoFi Beats <mrmelloslofibeats@gmail.example>',
  'To: mail@thewanderer.example',
  `Subject: ${o.subject}`,
  `Message-ID: <in-${o.uid}@gmail.example>`,
  `In-Reply-To: ${o.inReplyTo}`,
  'Date: Tue, 13 Oct 2026 09:25:00 +0200',
  'Content-Type: text/plain; charset=utf-8',
  '',
  o.body,
].join('\r\n')

const llmWith = (content: object) => (async () => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch

async function reload() {
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}

async function incomingReply(uid: number, body: string) {
  const [prev] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `THE-OLD-${String(uid).padStart(3, '0')}`, title: 'Antwort an Mr Mello', category: 'pflege', status: 'erledigt', draftKind: 'mail' }).returning()
  await db.insert(schema.mails).values({ workspaceId: ws.id, projectId: project.id, direction: 'out', status: 'gesendet', messageId: `<prev-${uid}@thewanderer.example>`, toAddr: 'mrmelloslofibeats@gmail.example', subject: 'The Bunnies Have Been Busy!', taskId: prev!.id, sentAt: new Date(), mode: 'manual' })
  await syncProjectMail(db, ws, project, backend([{ uid, raw: raw({ uid, body, inReplyTo: `<prev-${uid}@thewanderer.example>`, subject: 'Re: The Bunnies Have Been Busy!' }) }]).b)
  await reload()
  const [task] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.dependsOnId, prev!.id), like(schema.tasks.title, 'Antwort an%')))
  return task!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T09:30:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { sendLive: true, publishLive: true, llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  ownerId = (await db.insert(schema.users).values({ email: 'p@test.local', name: 'Peter' }).returning())[0]!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: ownerId, role: 'owner' })
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'The Wanderer', code: 'THE', icon: 'music', languages: ['en'], autonomy: { mail: 'auto_report', social: 'auto' }, rules: 'Mr Mello\'s LoFi Beats bekommt höchstens eine Antwort.' }).returning())[0]!
  const mail = buildMailSettings(ws.id, project.id, null, { imapHost: 'mail.test', imapPort: 993, imapSecure: true, smtpHost: 'mail.test', smtpPort: 465, smtpSecure: true, user: 'mail@thewanderer.example', from: 'The Wanderer <mail@thewanderer.example>', imapPassword: 'geheim' })
  await db.update(schema.projects).set({ setup: { mail } }).where(eq(schema.projects.id, project.id))
  await db.insert(schema.contacts).values({ workspaceId: ws.id, projectId: project.id, name: 'Mr Mello\'s LoFi Beats', email: 'mrmelloslofibeats@gmail.example', status: 'kontaktiert' })
  await reload()
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

const MELLO = 'Hey Triple J!\n\nGood to hear from you and thanks for introducing yourselves! At the moment with regards to the radio - chill lofi only. We usually don\'t add music when being sent by email but will give it a listen.\n\nBobby'

describe('Vorfall THE-PFL-007: Antwort auf Antwort, Stufe "selbst + melden", Senden nach außen an', () => {
  it('interne Notiz als Mailtext: kein Versand, Entwurf bleibt offen mit Nachprüfung, Senden blockiert', async () => {
    const task = await incomingReply(3, MELLO)
    await runDraftTask(db, ws, task.id, llmWith({ kind: 'mail', body: INCIDENT, notes: 'Diese Aufgabe nicht senden.' }))
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    expect(d!.status).toBe('offen')
    expect(d!.approvedAt).toBeNull()
    const out = await db.select().from(schema.mails).where(and(eq(schema.mails.taskId, task.id), eq(schema.mails.direction, 'out')))
    expect(out).toHaveLength(0)
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('entwurf_fertig')
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))).map(n => n.text).join('\n')
    expect(notes).toMatch(/Nachprüfung:.*interne[rn]? Notiz/)
    expect(notes).toMatch(/Sprache passt nicht/)
    const f = backend([])
    await expect(sendDraft(db, ws, { draftId: d!.id, mode: 'auto_report' }, f.b)).rejects.toThrow(/Klick eines Menschen/)
    await expect(sendDraft(db, ws, { draftId: d!.id, userId: ownerId, mode: 'manual' }, f.b)).rejects.toThrow(/interne[rn]? Notiz/)
    expect(f.sent).toHaveLength(0)
  })

  it('Modell entscheidet "nicht antworten": kein Entwurf, Aufgabe mit Notiz geschlossen', async () => {
    const task = await incomingReply(4, MELLO)
    const r = await runDraftTask(db, ws, task.id, llmWith({ kind: 'mail', body: '', skip: 'Laut Projekt-Regel nur eine Antwort an Mr Mello, die ist schon raus.' }))
    expect(r.summary).toMatch(/Kein Entwurf/)
    expect(await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))).toHaveLength(0)
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('verworfen')
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))).map(n => n.text)
    expect(notes.some(n => n.startsWith('Kein Entwurf, Aufgabe geschlossen: Laut Projekt-Regel'))).toBe(true)
    expect(await db.select().from(schema.mails).where(and(eq(schema.mails.taskId, task.id), eq(schema.mails.direction, 'out')))).toHaveLength(0)
  })

  it('gute Antwort: nur Entwurf zur Prüfung, Versand erst nach Klick, Ablage im Gesendet-Ordner (Fehler blockiert nicht)', async () => {
    const task = await incomingReply(5, MELLO)
    await runDraftTask(db, ws, task.id, llmWith({ kind: 'mail', body: GOOD }))
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    expect(d!.status).toBe('offen')
    expect(await db.select().from(schema.mails).where(and(eq(schema.mails.taskId, task.id), eq(schema.mails.direction, 'out')))).toHaveLength(0)
    const f = backend([])
    expect((await sendDraft(db, ws, { draftId: d!.id, userId: ownerId, mode: 'manual' }, f.b)).status).toBe('gesendet')
    expect(f.sent).toHaveLength(1)
    await new Promise(r => setTimeout(r, 0))
    expect(f.appended).toEqual([`raw:${GOOD}`])

    const task2 = await incomingReply(6, MELLO)
    await runDraftTask(db, ws, task2.id, llmWith({ kind: 'mail', body: GOOD }))
    const [d2] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task2.id))
    const broken = backend([], true)
    expect((await sendDraft(db, ws, { draftId: d2!.id, userId: ownerId, mode: 'manual' }, broken.b)).status).toBe('gesendet')
  })
})
