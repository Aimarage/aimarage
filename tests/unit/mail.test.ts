import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDraftTask } from '../../server/lib/agent'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { buildMailSettings, checkMail, decideSend, extractCode, mailInfo, mailInfoText, MailError, sendDraft, singleRecipient, syncProjectMail } from '../../server/lib/mail'
import { talkPrompt } from '../../server/prompts/talk'
import type { MailBackend, OutMessage } from '../../server/lib/mailer'
import { resetSecretCache } from '../../server/lib/secret'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let ownerId: string
let outSeq = 0

function fakeBackend(inbox: { uid: number, raw: string }[] = []) {
  const sent: OutMessage[] = []
  const appended: string[] = []
  const logins: string[] = []
  const seen: number[] = []
  const b: MailBackend = {
    async verifyImap(cfg, pass) {
      logins.push(`imap:${cfg.user}`)
      if (pass !== 'geheim') throw Object.assign(new Error(`Invalid credentials for ${pass}`), { authenticationFailed: true })
    },
    async verifySmtp(_cfg, pass) {
      if (pass !== 'geheim') throw Object.assign(new Error('535 auth failed'), { code: 'EAUTH' })
    },
    async fetchNew(_cfg, _pass, since) {
      return { uidValidity: '7', messages: inbox.filter(m => !since.uid || m.uid > since.uid).map(m => ({ uid: m.uid, source: Buffer.from(m.raw) })) }
    },
    async send(_cfg, _pass, msg) {
      sent.push(msg)
      return { messageId: `<out-${++outSeq}@tonebase.com>`, raw: Buffer.from('raw') }
    },
    async appendSent(_cfg, _pass, raw) {
      appended.push(raw.toString())
    },
    async markSeen(_cfg, _pass, uids) {
      seen.push(...uids)
    },
  }
  return { b, sent, appended, logins, seen }
}

const raw = (o: { from: string, subject: string, body: string, id: string, inReplyTo?: string, headers?: string[] }) => [
  `From: ${o.from}`,
  'To: Peter <peter@tonebase.com>',
  `Subject: ${o.subject}`,
  `Message-ID: ${o.id}`,
  ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
  ...(o.headers ?? []),
  'Date: Tue, 13 Oct 2026 07:00:00 +0200',
  'Content-Type: text/plain; charset=utf-8',
  '',
  o.body,
].join('\r\n')

async function reload() {
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  ownerId = (await db.insert(schema.users).values({ email: 'p@test.local', name: 'Peter' }).returning())[0]!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: ownerId, role: 'owner' })
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'music' }).returning())[0]!
  const mail = buildMailSettings(ws.id, project.id, null, { imapHost: 'mail.test', imapPort: 993, imapSecure: true, smtpHost: 'mail.test', smtpPort: 465, smtpSecure: true, user: 'peter@tonebase.com', from: 'Peter <peter@tonebase.com>', imapPassword: 'geheim' })
  await db.update(schema.projects).set({ setup: { mail } }).where(eq(schema.projects.id, project.id))
  await reload()
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Postfach', () => {
  it('Passwort verschlüsselt, Prüfen nur Anmeldung, Fehler ohne Passwort', async () => {
    expect(JSON.stringify(project.setup)).not.toContain('geheim')
    const f = fakeBackend()
    expect(await checkMail(db, ws, project, f.b)).toEqual({ imap: null, smtp: null })
    expect(f.sent).toHaveLength(0)
    const bad = buildMailSettings(ws.id, project.id, project.setup.mail, { imapHost: 'mail.test', imapPort: 993, imapSecure: true, smtpHost: 'mail.test', smtpPort: 465, smtpSecure: true, user: 'peter@tonebase.com', from: 'peter@tonebase.com', imapPassword: 'falsch12' })
    const r = await checkMail(db, ws, { ...project, setup: { mail: bad } }, f.b)
    expect(r.imap).toBe('IMAP: Anmeldung abgelehnt (Benutzer oder Passwort falsch)')
    expect(JSON.stringify(r)).not.toContain('falsch12')
  })
  it('Codes, Empfänger, Regeln', () => {
    expect(extractCode('Dein Bestätigungscode', 'Dein Code lautet 482913. Gültig 10 Min.').code).toBe('482913')
    expect(extractCode('Please verify', 'Click https://dir.example/verify?t=abc to confirm').link).toBe('https://dir.example/verify?t=abc')
    expect(extractCode('Hallo', 'Wir haben 2026 viele Pläne').code).toBeNull()
    expect(singleRecipient('Anna <anna@blog.example>')).toBe('anna@blog.example')
    expect(() => singleRecipient('a@x.de, b@y.de')).toThrow(/Nur ein Empfänger/)
    expect(decideSend({ autonomy: { outreach: 'auto' }, setup: project.setup }, { category: 'outreach', draftKind: 'mail' })).toEqual({ action: 'approve' })
    expect(decideSend({ autonomy: { mail: 'auto_report' }, setup: project.setup }, { category: 'pflege', draftKind: 'mail' })).toEqual({ action: 'approve' })
    expect(decideSend({ autonomy: { mail: 'auto' }, setup: project.setup }, { category: 'pflege', draftKind: 'mail' })).toEqual({ action: 'approve' })
  })
  it('Senden: Trockenlauf solange aus, danach einzeln über SMTP, Aufgabe wartet', async () => {
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'M-1', title: 'Pitch an Blog', description: 'Der Blog bittet um Einsendungen per Mail: https://blog.example/submit', category: 'outreach', status: 'entwurf_fertig', draftKind: 'mail' }).returning()
    const [draft] = await db.insert(schema.drafts).values({ taskId: task!.id, kind: 'mail', subject: 'Lossless-Musik', body: 'Hallo Anna, ...', recipient: 'anna@blog.example' }).returning()
    const f = fakeBackend()
    expect(await sendDraft(db, ws, { draftId: draft!.id, userId: ownerId, mode: 'manual' }, f.b)).toEqual({ status: 'trocken', to: 'anna@blog.example' })
    expect(f.sent).toHaveLength(0)
    await expect(sendDraft(db, ws, { draftId: draft!.id, mode: 'auto' }, f.b)).rejects.toThrow(MailError)
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, sendLive: true } }).where(eq(schema.workspaces.id, ws.id))
    await reload()
    expect((await sendDraft(db, ws, { draftId: draft!.id, userId: ownerId, mode: 'manual' }, f.b)).status).toBe('gesendet')
    expect(f.sent).toEqual([{ from: 'Peter <peter@tonebase.com>', to: 'anna@blog.example', subject: 'Lossless-Musik', text: 'Hallo Anna, ...', inReplyTo: null }])
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task!.id))
    expect(t!.status).toBe('wartet')
    expect(t!.followUpOn).toBe('2026-10-20')
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, 'anna@blog.example'))
    expect(c!.status).toBe('kontaktiert')
  })
  it('Gesperrte Kontakte bekommen nie Mails', async () => {
    await db.insert(schema.contacts).values({ workspaceId: ws.id, name: 'Dark Side', email: 'info@dss.example', status: 'gesperrt' })
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'M-2', title: 'Pitch', category: 'outreach', status: 'entwurf_fertig', draftKind: 'mail', targetUrl: 'https://dss.example/submissions' }).returning()
    await db.insert(schema.taskNotes).values({ taskId: task!.id, text: 'Einsendungen laut Seite erwünscht' })
    const [draft] = await db.insert(schema.drafts).values({ taskId: task!.id, kind: 'mail', body: 'x', recipient: 'info@dss.example' }).returning()
    await expect(sendDraft(db, ws, { draftId: draft!.id, userId: ownerId, mode: 'manual' }, fakeBackend().b)).rejects.toThrow(/gesperrt/)
  })
  it('Lesen: Antwort zugeordnet, Aufgabe erledigt, Antwort-Entwurf, Code im Protokoll; selbst gesendet als Antwort', async () => {
    const inbox = [
      { uid: 10, raw: raw({ from: 'Anna <anna@blog.example>', subject: 'Re: Lossless-Musik', body: 'Klingt spannend, schick mir mehr!\r\n\r\nAm 13.10. schrieb Peter:\r\n> Hallo Anna', id: '<in-1@blog.example>', inReplyTo: '<out-1@tonebase.com>' }) },
      { uid: 11, raw: raw({ from: 'noreply@dir.example', subject: 'Dein Bestätigungscode', body: 'Code: 551177', id: '<in-2@dir.example>' }) },
      { uid: 12, raw: raw({ from: 'news@shop.example', subject: 'Angebot', body: 'Rabatt', id: '<in-3@shop.example>' }) },
    ]
    const f = fakeBackend(inbox)
    const r = await syncProjectMail(db, ws, project, f.b)
    expect(r).toMatchObject({ fetched: 3, replies: 1, codes: 1 })
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.code, 'M-1'))
    expect(t!.status).toBe('erledigt')
    expect(t!.followUpOn).toBeNull()
    const acts = await db.select().from(schema.activity).where(eq(schema.activity.workspaceId, ws.id))
    expect(acts.find(a => a.action === 'mail_code')!.detail).toMatchObject({ code: '551177' })
    expect(acts.find(a => a.action === 'mail_reply')).toBeTruthy()
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, 'anna@blog.example'))
    expect(c!.status).toBe('warm')
    const reply = (await db.select().from(schema.tasks).where(eq(schema.tasks.dependsOnId, t!.id)))[0]!
    expect(reply.title).toContain('Antwort an Anna')
    expect(reply.description).toContain('Klingt spannend')
    expect(reply.description).not.toContain('> Hallo Anna')
    await reload()
    expect((await syncProjectMail(db, ws, project, f.b)).fetched).toBe(0)

    await db.update(schema.projects).set({ autonomy: { mail: 'auto_report' } }).where(eq(schema.projects.id, project.id))
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, llm: { provider: 'ollama', model: 'mock' } } }).where(eq(schema.workspaces.id, ws.id))
    await reload()
    const llm = async () => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify({ kind: 'mail', body: 'Hallo Anna, gern! Hier mehr ...' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    await runDraftTask(db, ws, reply.id, llm as unknown as typeof fetch)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, reply.id))
    expect(d!.recipient).toBe('anna@blog.example')
    expect(d!.subject).toBe('Re: Lossless-Musik')
    expect(d!.status).toBe('offen')
    expect(await db.select().from(schema.mails).where(eq(schema.mails.draftId, d!.id))).toHaveLength(0)
    await expect(sendDraft(db, ws, { draftId: d!.id, mode: 'auto' }, f.b)).rejects.toThrow(/Klick eines Menschen/)
    await sendDraft(db, ws, { draftId: d!.id, userId: ownerId, mode: 'manual' }, f.b)
    expect(f.sent.at(-1)).toMatchObject({ to: 'anna@blog.example', subject: 'Re: Lossless-Musik', inReplyTo: '<in-1@blog.example>' })
    const [rt] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, reply.id))
    expect(rt!.status).toBe('erledigt')
    expect((await db.select().from(schema.activity).where(eq(schema.activity.taskId, reply.id))).find(a => a.action === 'mail_sent')).toBeTruthy()
  })
  it('Lesen: Rundmails und Benachrichtigungen sind keine Antwort, ohne Bezug normale Priorität', async () => {
    await db.insert(schema.contacts).values([
      { workspaceId: ws.id, name: 'Mello', email: 'beats@mello.example', status: 'kontaktiert' },
      { workspaceId: ws.id, name: 'Bob', email: 'bob@label.example', status: 'kontaktiert' },
      { workspaceId: ws.id, name: 'Playlist', email: 'no-reply@playlist.example', status: 'kontaktiert' },
      { workspaceId: ws.id, name: 'Carl', email: 'carl@zine.example', status: 'kontaktiert' },
    ])
    const [bobTask] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'M-3', title: 'Mail an Bob', category: 'pflege', status: 'wartet', draftKind: 'mail' }).returning()
    await db.insert(schema.mails).values({ workspaceId: ws.id, projectId: project.id, direction: 'out', status: 'gesendet', messageId: '<out-bob@tonebase.com>', toAddr: 'bob@label.example', subject: 'Neuer Song', taskId: bobTask!.id, sentAt: new Date() })
    const before = (await db.select().from(schema.tasks)).length
    const inbox = [
      { uid: 20, raw: raw({ from: 'Mello <beats@mello.example>', subject: 'Ten Houses. One Kingdom of Beats.', body: 'Diese Woche neu ...', id: '<nl-1@mello.example>', headers: ['List-Unsubscribe: <https://mello.example/unsub?u=1>', 'Precedence: bulk'] }) },
      { uid: 21, raw: raw({ from: 'Bob <bob@label.example>', subject: 'Re: Neuer Song', body: 'Gefällt mir, gerne mehr.', id: '<in-bob@label.example>', inReplyTo: '<out-bob@tonebase.com>' }) },
      { uid: 22, raw: raw({ from: 'Playlist <no-reply@playlist.example>', subject: 'Neue Playlist-Aktion', body: 'Jetzt buchen', id: '<n-1@playlist.example>' }) },
      { uid: 23, raw: raw({ from: 'Carl <carl@zine.example>', subject: 'Frage zum Album', body: 'Wann kommt das Album?', id: '<in-carl@zine.example>' }) },
    ]
    const r = await syncProjectMail(db, ws, project, fakeBackend(inbox).b)
    expect(r).toMatchObject({ fetched: 4, replies: 2 })
    const tasks = await db.select().from(schema.tasks)
    expect(tasks).toHaveLength(before + 2)
    expect(tasks.find(t => t.title.includes('Mello') || t.title.includes('Playlist'))).toBeUndefined()
    const bob = tasks.find(t => t.title.startsWith('Antwort an Bob'))!
    expect(bob.prio).toBe('P1')
    expect(bob.dependsOnId).toBe(bobTask!.id)
    expect(tasks.find(t => t.title.startsWith('Antwort an Carl'))!.prio).toBe('P2')
    const nl = (await db.select().from(schema.mails).where(eq(schema.mails.messageId, '<nl-1@mello.example>')))[0]!
    expect(nl).toMatchObject({ kind: 'other', taskId: null })
    expect(nl.contactId).toBeTruthy()
    const [mello] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, 'beats@mello.example'))
    expect(mello!.status).toBe('kontaktiert')
    const [n] = await db.select().from(schema.mails).where(eq(schema.mails.messageId, '<n-1@playlist.example>'))
    expect(n).toMatchObject({ kind: 'other', taskId: null })
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'draft_task'))
    expect(jobs.filter(j => j.payload.taskId === bob.id)).toHaveLength(1)
  })
  it('Mail-Metadaten: Datum, Absender, frühere Mails; im Chat-Prompt; alte Aufgaben per Migration', async () => {
    const bob = (await db.select().from(schema.tasks)).find(t => t.title.startsWith('Antwort an Bob'))!
    const info = (await mailInfo(db, bob.id))!
    expect(info).toMatchObject({ from: 'bob@label.example', fromName: 'Bob', to: 'peter@tonebase.com', subject: 'Re: Neuer Song', messageId: '<in-bob@label.example>', inReplyTo: '<out-bob@tonebase.com>' })
    expect(info.date).toBe('2026-10-13T05:00:00.000Z')
    expect(info.earlier).toEqual([expect.objectContaining({ direction: 'out', subject: 'Neuer Song', task: 'M-3' })])
    const text = mailInfoText(info, 'Europe/Vienna')
    expect(text).toContain('13.10.2026')
    expect(text).toContain('07:00')
    expect(text).toContain('gesendet (unsere Antwort): Neuer Song [M-3]')
    const prompt = talkPrompt({ project: null, task: { code: bob.code, title: bob.title, description: bob.description, channel: null, language: null }, facts: { known: [], avoid: [] }, memory: [], draft: null, notes: [], history: [], message: 'Von wann ist diese Mail?', canRevise: false, mail: text })
    expect(prompt).toContain('Datum der Mail:')
    expect(prompt).toContain('keinen Einblick ins Postfach')

    const carl = (await db.select().from(schema.tasks)).find(t => t.title.startsWith('Antwort an Carl'))!
    await db.update(schema.mails).set({ sentAt: null }).where(sql`${schema.mails.taskId} = ${carl.id} and ${schema.mails.messageId} is null`)
    const before = (await mailInfo(db, carl.id))!
    expect(before.date).toBe('2026-10-13T05:00:00.000Z')
    await db.update(schema.mails).set({ sentAt: null }).where(eq(schema.mails.messageId, '<in-carl@zine.example>'))
    expect((await mailInfo(db, carl.id))!.date).toBeNull()
    expect(mailInfoText((await mailInfo(db, carl.id))!, 'Europe/Vienna')).toContain('nicht gespeichert')
    await db.update(schema.mails).set({ sentAt: new Date('2026-10-12T10:30:00Z') }).where(eq(schema.mails.messageId, '<in-carl@zine.example>'))
    const mig = readFileSync(new URL('../../server/db/migrations/0022_mail_dates.sql', import.meta.url), 'utf8')
    await db.execute(sql.raw(mig))
    await db.execute(sql.raw(mig))
    const [stub] = await db.select().from(schema.mails).where(sql`${schema.mails.taskId} = ${carl.id} and ${schema.mails.messageId} is null`)
    expect(stub!.sentAt?.toISOString()).toBe('2026-10-12T10:30:00.000Z')
  })
})

describe('Projekt-Import und Regeln', () => {
  it('legt Projekt mit Regeln, Zielen, Kontakten an; Regeln stehen im Agent-Prompt', async () => {
    const { importProject } = await import('../../server/lib/project-import')
    const r = await importProject(db, ws, ownerId, { name: 'The Wanderer', url: 'https://thewandererai.com', color: 'violet', rules: 'Nie Wien erwähnen.', pacing: 1, autonomy: { social: 'auto', mail: 'auto_report', community: 'auto' }, goals: [{ label: 'Spotify-Hörer pro Monat', metricKey: 'spotify_listeners', mode: 'last', targetValue: 50, deadline: '2027-01-05' }], contacts: [{ name: 'RetroSynth', email: 'info@retrosynthrecords.com', status: 'warm' }, { name: 'Anna', email: 'ANNA@blog.example', status: 'gesperrt' }] }, 'thewanderer')
    expect(r).toMatchObject({ slug: 'thewanderer', contacts: 2, goals: 1 })
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, r.id))
    expect(p!.autonomy).toMatchObject({ social: 'auto', community: 'approve', outreach: 'approve' })
    expect(p!.setup.pacing).toEqual({ perPlatformPerDay: 1 })
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, 'anna@blog.example'))
    expect(c!.status).toBe('gesperrt')
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: r.id, code: 'TV-1', title: 'Post', category: 'social', status: 'geplant', draftKind: 'post', dueDate: '2026-10-14' }).returning()
    let system = ''
    const llm = async (_u: string, init: RequestInit) => {
      system ||= JSON.parse(String(init.body)).messages[0].content
      return new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify({ kind: 'post', body: 'New track out' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    }
    await runDraftTask(db, ws, task!.id, llm as unknown as typeof fetch)
    expect(system).toContain('VERBINDLICHE PROJEKT-REGELN')
    expect(system).toContain('Nie Wien erwähnen.')
  })
})
