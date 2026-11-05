import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountService, importantText, inboxLineText, notableInfo, ruleCategory, type MailFacts } from '../../shared/utils/inbox'
import { accountKnown } from '../../shared/utils/service'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { inboxSummary, mailDoneStates } from '../../server/lib/inbox'
import { llmConfig } from '../../server/lib/llm'
import { buildMailSettings, correctMail, markMailDone, syncProjectMail } from '../../server/lib/mail'
import type { MailBackend } from '../../server/lib/mailer'
import { actionableInbox, digestText, morningDigests } from '../../server/lib/morning-digest'
import { resetSecretCache } from '../../server/lib/secret'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let ownerId: string

const facts = (o: Partial<MailFacts>): MailFacts => ({ from: 'x@example.com', fromName: null, subject: '', text: '', bulk: false, list: false, ...o })

function fakeBackend(inbox: { uid: number, raw: string }[]) {
  const seen: number[][] = []
  const b: MailBackend = {
    async verifyImap() {},
    async verifySmtp() {},
    async fetchNew(_c, _p, since) {
      return { uidValidity: '9', messages: inbox.filter(m => !since.uid || m.uid > since.uid).map(m => ({ uid: m.uid, source: Buffer.from(m.raw) })) }
    },
    async send() {
      throw new Error('kein Versand im Test')
    },
    async appendSent() {},
    async markSeen(_c, _p, uids, uidValidity) {
      expect(uidValidity).toBe('9')
      seen.push(uids)
    },
  }
  return { b, seen }
}

const raw = (o: { from: string, subject: string, body: string, id: string, headers?: string[], to?: string }) => [
  `From: ${o.from}`,
  `To: ${o.to ?? 'The Wanderer <band@thewanderer.example>'}`,
  `Subject: ${o.subject}`,
  `Message-ID: ${o.id}`,
  ...(o.headers ?? []),
  'Date: Tue, 13 Oct 2026 07:00:00 +0200',
  'Content-Type: text/plain; charset=utf-8',
  '',
  o.body,
].join('\r\n')

function fakeLlm(items: { i: number, category: string, note?: string | null, service?: string | null }[]) {
  const prompts: string[] = []
  const fn = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] }
    prompts.push(body.messages.map(m => m.content).join('\n'))
    return new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
  }
  return { fn, prompts }
}

const llm = llmConfig({ provider: 'ollama', model: 'mock' })

async function reload() {
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
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'visitors', name: 'Visitors', code: 'THE', icon: 'music' }).returning())[0]!
  const mail = buildMailSettings(ws.id, project.id, null, { imapHost: 'mail.test', imapPort: 993, imapSecure: true, smtpHost: 'mail.test', smtpPort: 465, smtpSecure: true, user: 'band@thewanderer.example', from: 'The Wanderer <band@thewanderer.example>', imapPassword: 'geheim' })
  await db.update(schema.projects).set({ setup: { mail } }).where(eq(schema.projects.id, project.id))
  await reload()
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Einordnung per Regel', () => {
  it('Sicherheit, Konto, Plattform, Rundmail; sonst KI', () => {
    expect(ruleCategory(facts({ from: 'info@x.com', subject: 'Password reset request' }), { code: null, link: null })).toEqual({ category: 'wichtig', note: '@pwreset' })
    expect(ruleCategory(facts({ from: 'support@bsky.app', subject: 'Welcome to Bluesky' }), { code: null, link: null })).toEqual({ category: 'wichtig', note: '@welcome' })
    expect(ruleCategory(facts({ from: 'notifications@mastodon.social', subject: 'Max hat dich erwähnt' }), { code: null, link: null })?.category).toBe('info')
    expect(ruleCategory(facts({ from: 'hello@dailyplaylists.com', subject: 'Daily Playlists: Your submissions have been reviewed', list: true, bulk: true }), { code: null, link: null })).toEqual({ category: 'info', note: '@submission' })
    expect(ruleCategory(facts({ from: 'news@mello.example', subject: 'Neue Beats', bulk: true, list: true }), { code: null, link: null })?.category).toBe('newsletter')
    expect(ruleCategory(facts({ from: 'billing@stripe.example', subject: 'Your receipt from Stripe' }), { code: null, link: null })?.note).toBe('@payment')
    expect(ruleCategory(facts({ from: 'news@shop.example', subject: 'Rechnung sparen mit unserem Angebot', bulk: true, list: true }), { code: null, link: null })?.category).toBe('newsletter')
    expect(ruleCategory(facts({ from: 'anna@blog.example', subject: 'Frage zu eurem Album' }), { code: null, link: null })).toBeNull()
  })
  it('erkennt Konten aus Willkommens- und Bestätigungs-Mails', () => {
    expect(accountService(facts({ from: 'support@bsky.app', subject: 'Welcome to Bluesky' }))).toBe('Bluesky')
    expect(accountService(facts({ from: 'notifications@mastodon.social', subject: 'Willkommen bei Mastodon' }))).toBe('Mastodon')
    expect(accountService(facts({ from: 'hello@dailyplaylists.com', subject: 'Daily Playlists: Your submissions', list: true }))).toBe('DailyPlaylists')
    expect(accountService(facts({ from: 'info@x.com', subject: 'Password reset request' }))).toBe('X')
    expect(accountService(facts({ from: 'team@groovy.example', fromName: 'Groovy Team', subject: 'Welcome to Groovy!' }))).toBe('Groovy')
    expect(accountService(facts({ from: 'news@shop.example', subject: 'Welcome to our newsletter', list: true }))).toBeNull()
    expect(accountService(facts({ from: 'anna@blog.example', subject: 'Hallo' }))).toBeNull()
  })
  it('Zeilen für Morgen-Mail', () => {
    const l = { projectId: 'p', slug: 'visitors', name: 'Visitors', counts: { total: 12, antwort: 1, wichtig: 2, info: 0, newsletter: 7, spam: 2 }, important: [{ id: '1', from: 'X', note: '@pwreset', subject: 'Password reset request' }] }
    expect(inboxLineText(l, 'de')).toBe('Postfach Visitors: 12 neu - 1 braucht Antwort, 2 wichtig, 9 Newsletter/Werbung')
    expect(inboxLineText(l, 'en')).toBe('Mailbox Visitors: 12 new - 1 needs a reply, 2 important, 9 newsletters/ads')
    expect(importantText(l.important[0]!, 'de')).toBe('Wichtig im Postfach: X - Passwort zurücksetzen angefordert')
  })
})

describe('Postfach einordnen', () => {
  const inbox = [
    { uid: 1, raw: raw({ from: 'Anna <anna@blog.example>', subject: 'Frage zu eurem Album', body: 'Hallo, wann erscheint das Album? Ich würde gern darüber schreiben.', id: '<a-1@blog.example>' }) },
    { uid: 2, raw: raw({ from: 'Plays Agency <deals@plays.example>', subject: 'Get 10k Spotify streams', body: 'We place your track on playlists with 100k followers. Only 99 USD.', id: '<s-1@plays.example>' }) },
    { uid: 3, raw: raw({ from: 'Bluesky <support@bsky.app>', subject: 'Welcome to Bluesky', body: 'Your account is ready.', id: '<w-1@bsky.app>' }) },
    { uid: 4, raw: raw({ from: 'X <info@x.com>', subject: 'Password reset request', body: 'Someone requested a password reset.', id: '<x-1@x.com>' }) },
    { uid: 5, raw: raw({ from: 'Mello <news@mello.example>', subject: 'Neue Beats', body: 'Diese Woche neu', id: '<n-1@mello.example>', headers: ['List-Unsubscribe: <https://mello.example/u>'] }) },
    { uid: 6, raw: raw({ from: 'Daily Playlists <hello@dailyplaylists.com>', subject: 'Daily Playlists: Your submissions', body: 'Status deiner Einreichungen', id: '<d-1@dailyplaylists.com>', headers: ['List-Unsubscribe: <https://dailyplaylists.com/u>'] }) },
    { uid: 7, raw: raw({ from: 'Bank <service@bank.example>', subject: 'Hinweis zu Ihrem Konto', body: 'Bitte prüfen Sie die Lastschrift.', id: '<b-1@bank.example>' }) },
  ]

  it('Regeln zuerst, KI nur für den Rest; nur "braucht Antwort" wird Aufgabe; Rundmails gelesen markiert; Konten gemerkt', async () => {
    const { fn, prompts } = fakeLlm([{ i: 0, category: 'antwort' }, { i: 1, category: 'spam' }, { i: 2, category: 'wichtig', note: 'Lastschrift prüfen' }])
    const f = fakeBackend(inbox)
    const before = (await db.select().from(schema.tasks)).length
    const r = await syncProjectMail(db, ws, project, f.b, { llm, llmFetch: fn })
    expect(r.fetched).toBe(7)
    expect(r.replies).toBe(1)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('anna@blog.example')
    expect(prompts[0]).toContain('deals@plays.example')
    expect(prompts[0]).toContain('service@bank.example')
    expect(prompts[0]).not.toContain('bsky.app')
    expect(prompts[0]).not.toContain('mello.example')
    const rows = await db.select().from(schema.mails).where(and(eq(schema.mails.projectId, project.id), eq(schema.mails.direction, 'in')))
    const cat = (id: string) => rows.find(m => m.messageId === id)!
    expect(cat('<a-1@blog.example>')).toMatchObject({ category: 'antwort', categoryBy: 'ki', kind: 'reply' })
    expect(cat('<s-1@plays.example>')).toMatchObject({ category: 'spam', categoryBy: 'ki', taskId: null })
    expect(cat('<w-1@bsky.app>')).toMatchObject({ category: 'wichtig', categoryBy: 'regel', note: '@welcome' })
    expect(cat('<x-1@x.com>')).toMatchObject({ category: 'wichtig', note: '@pwreset', fromName: 'X' })
    expect(cat('<n-1@mello.example>')).toMatchObject({ category: 'newsletter' })
    expect(cat('<d-1@dailyplaylists.com>')).toMatchObject({ category: 'info' })
    expect(cat('<b-1@bank.example>')).toMatchObject({ category: 'wichtig', note: 'Lastschrift prüfen' })
    const tasks = await db.select().from(schema.tasks)
    expect(tasks).toHaveLength(before + 1)
    expect(tasks.find(t => t.title.startsWith('Antwort an Anna'))).toBeTruthy()
    expect(f.seen).toEqual([[2, 5, 6]])
    const mem = (await db.select().from(schema.projectMemory).where(eq(schema.projectMemory.projectId, project.id))).map(m => m.text)
    for (const s of ['Bluesky', 'X', 'DailyPlaylists']) expect(accountKnown(s, mem)).toBe(true)
    expect(accountKnown('Plays Agency', mem)).toBe(false)
    expect(mem.filter(m => m.includes('Bluesky'))).toHaveLength(1)
    await reload()
    expect((await syncProjectMail(db, ws, project, f.b, { llm, llmFetch: fn })).fetched).toBe(0)
    expect(prompts).toHaveLength(1)
  })

  it('Übersicht je Postfach für Dashboard und Morgen-Mail', async () => {
    const lines = await inboxSummary(db, ws.id, { since: new Date('2026-10-12T00:00:00Z') })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.counts).toEqual({ total: 7, antwort: 1, wichtig: 3, info: 1, newsletter: 1, spam: 1 })
    expect(inboxLineText(lines[0]!, 'de')).toBe('Postfach Visitors: 7 neu - 1 braucht Antwort, 3 wichtig, 1 Benachrichtigung, 2 Newsletter/Werbung')
    const g = (await morningDigests(db, ws)).find(d => d.userId === ownerId)!
    const text = digestText(g, 'de')
    expect(text.body).toContain('Postfach Visitors:')
    expect(text.body).toContain('- X: Passwort zurücksetzen angefordert (ansehen)')
    expect(text.body).not.toContain('Anna')
    expect(text.body).not.toContain('Plays')
    expect(text.body).not.toContain('Benachrichtigung')
    expect(text.body).toContain('/p/visitors/postfach')
  })

  it('Korrektur von Hand: Regel für den Absender, Aufgabe angelegt bzw. verworfen', async () => {
    const [spam] = await db.select().from(schema.mails).where(eq(schema.mails.messageId, '<s-1@plays.example>'))
    const res = await correctMail(db, ws, spam!.id, 'antwort', ownerId)
    expect(res.taskId).toBeTruthy()
    await reload()
    expect(project.setup.mail!.rules).toEqual({ 'deals@plays.example': 'antwort' })
    const back = await correctMail(db, ws, spam!.id, 'spam', ownerId)
    expect(back.dropped).toBe(true)
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, res.taskId!))
    expect(t!.status).toBe('verworfen')
    await reload()
    expect(project.setup.mail!.rules).toEqual({ 'deals@plays.example': 'spam' })

    await db.update(schema.projects).set({ setup: { ...project.setup, mail: { ...project.setup.mail!, markSeen: false } } }).where(eq(schema.projects.id, project.id))
    await reload()
    const { fn, prompts } = fakeLlm([])
    const f = fakeBackend([{ uid: 8, raw: raw({ from: 'Plays Agency <deals@plays.example>', subject: 'Last chance: 20k streams', body: 'Hi again', id: '<s-2@plays.example>' }) }])
    await syncProjectMail(db, ws, project, f.b, { llm, llmFetch: fn })
    expect(prompts).toHaveLength(0)
    const [m] = await db.select().from(schema.mails).where(eq(schema.mails.messageId, '<s-2@plays.example>'))
    expect(m).toMatchObject({ category: 'spam', categoryBy: 'mensch' })
    expect(f.seen).toEqual([])
  })

  it('ohne KI bleibt Unbekanntes ungelesen und wichtig, keine Aufgabe', async () => {
    const before = (await db.select().from(schema.tasks)).length
    const f = fakeBackend([{ uid: 9, raw: raw({ from: 'Carl <carl@zine.example>', subject: 'Hallo', body: 'Kurze Frage', id: '<c-1@zine.example>' }) }])
    await syncProjectMail(db, ws, project, f.b)
    const [m] = await db.select().from(schema.mails).where(eq(schema.mails.messageId, '<c-1@zine.example>'))
    expect(m).toMatchObject({ category: 'wichtig', taskId: null })
    expect((await db.select().from(schema.tasks)).length).toBe(before)
    expect(f.seen).toEqual([])
  })
})

describe('Erledigt und Rundmails bekannter Kontakte', () => {
  it('bedeutsame Benachrichtigungen erkennen', () => {
    expect(notableInfo('Wir haben dein Konto auf Instagram zu einem Meta-Konto gemacht')).toBe(true)
    expect(notableInfo('Your account has been restricted')).toBe(true)
    expect(notableInfo('Max hat dich erwähnt')).toBe(false)
    expect(notableInfo('Important: Facebook login is going away')).toBe(false)
  })

  it('Tagesmail ohne reine Benachrichtigungen und ohne Antworten, die schon eine Aufgabe haben', () => {
    const counts = { total: 1, antwort: 0, wichtig: 0, info: 1, newsletter: 0, spam: 0 }
    const base = { projectId: 'p', slug: 'visitors', name: 'Visitors', counts, important: [] }
    expect(actionableInbox([{ ...base, notable: [] }])).toEqual([])
    expect(actionableInbox([{ ...base, notable: [{ id: '1', kind: 'antwort', from: 'Anna', note: null, subject: 'Frage', taskId: 't' }] }])).toEqual([])
    const meta = actionableInbox([{ ...base, notable: [{ id: '2', kind: 'info', from: 'Meta', note: null, subject: 'Wir haben dein Konto auf Instagram zu einem Meta-Konto gemacht' }] }])
    expect(meta).toHaveLength(1)
    const text = digestText({ userId: 'u', minutes: 0, items: [], inbox: meta }, 'de')
    expect(text.subject).toBe('Postfach: Meta - Wir haben dein Konto auf Instagram zu einem Meta-Konto gemacht')
    expect(text.body).toContain('- Meta: Wir haben dein Konto auf Instagram zu einem Meta-Konto gemacht (nur zur Info)')
  })

  it('Rundmail eines bekannten Kontakts geht an die KI statt automatisch "braucht Antwort"', async () => {
    await db.update(schema.projects).set({ setup: { ...project.setup, mail: { ...project.setup.mail!, rules: {} } } }).where(eq(schema.projects.id, project.id))
    await reload()
    const before = (await db.select().from(schema.tasks)).length
    const { fn, prompts } = fakeLlm([{ i: 0, category: 'newsletter' }])
    const f = fakeBackend([{ uid: 20, raw: raw({ from: 'Anna <anna@blog.example>', to: 'anna@blog.example', subject: 'A Little Support Goes a Long Way!', body: 'Hello, music lovers! Please stream and share our new track.', id: '<a-news@blog.example>' }) }])
    await syncProjectMail(db, ws, project, f.b, { llm, llmFetch: fn })
    expect(prompts[0]).toContain('Bekannter Kontakt: ja')
    expect(prompts[0]).toContain('An sich selbst adressiert')
    const [m] = await db.select().from(schema.mails).where(eq(schema.mails.messageId, '<a-news@blog.example>'))
    expect(m).toMatchObject({ category: 'newsletter', categoryBy: 'ki' })
    expect((await db.select().from(schema.tasks)).length).toBe(before)
  })

  it('Erledigt gilt nur für diese Mail, verwirft die offene Antwort-Aufgabe und zählt nicht mehr', async () => {
    const [anna] = await db.select().from(schema.mails).where(eq(schema.mails.messageId, '<a-1@blog.example>'))
    expect((await mailDoneStates(db, [anna!])).get(anna!.id)).toBe('offen')
    await reload()
    const rulesBefore = project.setup.mail!.rules
    const r = await markMailDone(db, ws, anna!.id, true, ownerId)
    expect(r.dropped).toBe(true)
    const [after] = await db.select().from(schema.mails).where(eq(schema.mails.id, anna!.id))
    expect(after).toMatchObject({ status: 'erledigt', category: 'antwort' })
    expect((await mailDoneStates(db, [after!])).get(anna!.id)).toBe('erledigt')
    await reload()
    expect(project.setup.mail!.rules).toEqual(rulesBefore)
    const lines = await inboxSummary(db, ws.id, { since: new Date('2026-10-12T00:00:00Z') })
    expect(lines[0]!.counts.antwort).toBe(0)
    expect(lines[0]!.notable!.some(n => n.id === anna!.id)).toBe(false)
  })
})
