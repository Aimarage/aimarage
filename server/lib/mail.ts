import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { addDays } from '../../shared/utils/dates'
import { COLD_MAIL_TEXT, mailRelevant, submissionSource } from '../../shared/utils/coldmail'
import { OPEN_STATUSES, type Prio } from '../../shared/utils/domain'
import { hasPlaceholder } from '../../shared/utils/social'
import { internalTextProblems } from '../../shared/utils/outbound-guard'
import { accountService, isMailCat, ruleCategory, type MailCat } from '../../shared/utils/inbox'
import type { ProjectMail } from '../db/schema'
import { logActivity } from './activity'
import { now, today } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { rememberAccount, triageMails, type TriageDeps, type TriageInput } from './inbox'
import { enqueueJob } from './jobs'
import { keyHint, redactKey } from './llm'
import { addressOf, mailServerUnreachable, realBackend, type MailBackend, type MailPasswords } from './mailer'
import { effectiveAutonomy } from './outlets'
import { decryptSecret, encryptSecret } from './secret'
import { createTask, updateTask } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type Draft = typeof schema.drafts.$inferSelect

export class MailError extends Error {
  constructor(message: string, public code: string | null = null) {
    super(message)
  }
}

export const SMTP_UNREACHABLE = 'Mailserver nicht erreichbar (Zeitüberschreitung). Prüfe den Versand-Port in Konten > Postfach.'
const IMAP_UNREACHABLE = 'Mailserver nicht erreichbar (Zeitüberschreitung). Prüfe Server und Port für den Empfang in Konten > Postfach.'

const LATE_HOURS = 24

function ctxOf(workspaceId: string, projectId: string): string {
  return `mail|${workspaceId}|${projectId}`
}

export interface MailInput {
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  user: string
  smtpUser?: string | null
  from: string
  imapPassword?: string | null
  smtpPassword?: string | null
}

export function buildMailSettings(workspaceId: string, projectId: string, cur: ProjectMail | null | undefined, input: MailInput): ProjectMail {
  const old = cur ? openMailPasswords(workspaceId, projectId, cur) : null
  const imap = input.imapPassword || old?.imap || ''
  const smtp = input.smtpPassword || input.imapPassword || old?.smtp || ''
  if (!imap || !smtp) throw new MailError('Passwort fehlt')
  return {
    imap: { host: input.imapHost.trim(), port: input.imapPort, secure: input.imapSecure, user: input.user.trim() },
    smtp: { host: input.smtpHost.trim(), port: input.smtpPort, secure: input.smtpSecure, user: (input.smtpUser || input.user).trim() },
    from: input.from.trim(),
    secret: { enc: encryptSecret(JSON.stringify({ imap, smtp }), ctxOf(workspaceId, projectId)), hint: keyHint(smtp), setAt: new Date().toISOString() },
    checkedAt: null,
    error: null,
    lastUid: cur && cur.imap.host === input.imapHost.trim() && cur.imap.user === input.user.trim() ? cur.lastUid ?? null : null,
    uidValidity: cur && cur.imap.host === input.imapHost.trim() && cur.imap.user === input.user.trim() ? cur.uidValidity ?? null : null,
    lastSync: cur?.lastSync ?? null,
    markSeen: cur?.markSeen ?? null,
    rules: cur?.rules ?? null,
  }
}

export function openMailPasswords(workspaceId: string, projectId: string, m: ProjectMail): MailPasswords | null {
  const plain = decryptSecret(m.secret.enc, ctxOf(workspaceId, projectId))
  if (!plain) return null
  try {
    return JSON.parse(plain) as MailPasswords
  }
  catch {
    return null
  }
}

export function publicMail(m: ProjectMail | null | undefined) {
  if (!m) return null
  return { imap: m.imap, smtp: m.smtp, from: m.from, hint: m.secret.hint, checkedAt: m.checkedAt ?? null, error: m.error ?? null, lastSync: m.lastSync ?? null, markSeen: markSeenOn(m) }
}

export function markSeenOn(m: Pick<ProjectMail, 'markSeen'> | null | undefined): boolean {
  return m?.markSeen !== false
}

export async function setMail(db: Db, project: Pick<Project, 'id'>, patch: Partial<ProjectMail>): Promise<void> {
  const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, project.id))
  if (!p?.setup?.mail) return
  await db.update(schema.projects).set({ setup: { ...p.setup, mail: { ...p.setup.mail, ...patch } } }).where(eq(schema.projects.id, project.id))
}

function cleanErr(err: unknown, pw: MailPasswords | null, kind: 'imap' | 'smtp' = 'smtp'): string {
  if (mailServerUnreachable(err)) return kind === 'smtp' ? SMTP_UNREACHABLE : IMAP_UNREACHABLE
  const e = err as { message?: string, responseText?: string, response?: string, code?: string, authenticationFailed?: boolean }
  let msg = e.authenticationFailed || /auth|535|login/i.test(`${e.code ?? ''} ${e.response ?? ''} ${e.responseText ?? ''}`) ? 'Anmeldung abgelehnt (Benutzer oder Passwort falsch)' : (e.responseText || e.response || e.message || String(err))
  if (pw) msg = redactKey(redactKey(msg, pw.imap), pw.smtp)
  return msg.slice(0, 300)
}

export const SMTP_FALLBACK = { port: 587, secure: false } as const

async function withSmtpFallback<T>(db: Db, ws: Pick<Workspace, 'id'>, project: Pick<Project, 'id' | 'name'>, m: ProjectMail, run: (cfg: ProjectMail['smtp']) => Promise<T>, userId: string | null = null): Promise<{ result: T, switched: boolean }> {
  try {
    return { result: await run(m.smtp), switched: false }
  }
  catch (err) {
    if (m.smtp.port !== 465 || !mailServerUnreachable(err)) throw err
    const alt = { ...m.smtp, ...SMTP_FALLBACK }
    let result: T
    try {
      result = await run(alt)
    }
    catch (err2) {
      throw mailServerUnreachable(err2) ? err : err2
    }
    await setMail(db, project, { smtp: alt })
    await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: userId ? 'user' : 'agent', userId, action: 'mailbox_port_switched', detail: { title: project.name, from: m.smtp.port, to: alt.port }, at: now() })
    return { result, switched: true }
  }
}

export async function checkMail(db: Db, ws: Workspace, project: Project, backend: MailBackend = realBackend, userId: string | null = null): Promise<{ imap: string | null, smtp: string | null, switched?: boolean }> {
  const m = project.setup?.mail
  if (!m) throw new MailError('Kein Postfach eingetragen')
  const pw = openMailPasswords(ws.id, project.id, m)
  if (!pw) throw new MailError('Passwort unlesbar, bitte neu eintragen')
  const res: { imap: string | null, smtp: string | null, switched?: boolean } = { imap: null, smtp: null }
  try {
    await backend.verifyImap(m.imap, pw.imap)
  }
  catch (err) {
    res.imap = `IMAP: ${cleanErr(err, pw, 'imap')}`
  }
  try {
    const r = await withSmtpFallback(db, ws, project, m, cfg => backend.verifySmtp(cfg, pw.smtp), userId)
    if (r.switched) res.switched = true
  }
  catch (err) {
    res.smtp = `SMTP: ${cleanErr(err, pw)}`
  }
  await setMail(db, project, { checkedAt: now().toISOString(), error: [res.imap, res.smtp].filter(Boolean).join('; ') || null })
  return res
}

export function extractCode(subject: string, text: string): { code: string | null, link: string | null } {
  const hay = `${subject}\n${text}`.slice(0, 20_000)
  const m = /(code|kod|pin|otp|bestätigung|bestaetigung|verification|verify|einmal|passcode|sicherheits)[^\n\d]{0,60}?\b([A-Z0-9]{0,2}\d{4,8})\b/i.exec(hay) ?? /\b(\d{6})\b(?=[^\n]{0,40}(code|kod|bestätigung|verification))/i.exec(hay)
  const code = m ? (m[2] && /\d/.test(m[2]) ? m[2] : m[1]) ?? null : null
  const link = /https?:\/\/[^\s"'<>]*(confirm|verify|verif|bestaetig|bestätig|activate|aktivier|validate|optin|opt-in)[^\s"'<>]*/i.exec(hay)?.[0] ?? null
  return { code: code && /^\w{4,10}$/.test(code) ? code : null, link }
}

export interface ParsedMail {
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  bulk: boolean
  list: boolean
  from: string
  fromName: string | null
  to: string
  subject: string
  text: string
  date: Date
}

const BULK_HEADERS = ['list-unsubscribe', 'list-id', 'list-post', 'x-campaign', 'x-campaignid', 'x-campaign-id', 'x-mc-user', 'x-mailchimp-campaign', 'x-sib-id', 'x-mailin-campaign', 'x-ck-campaign', 'x-mailerlite-campaign', 'x-klaviyo-campaign', 'x-hs-campaign']
const BULK_MAILER = /mailchimp|mandrill|substack|brevo|sendinblue|convertkit|kit\.com|mailerlite|klaviyo|hubspot|campaign monitor|createsend|getresponse|activecampaign|cleverreach|rapidmail|newsletter2go|mailjet|beehiiv|buttondown|sendy|phplist|mailpoet/i
const BULK_SENDER = /^(no-?reply|do-?not-?reply|notifications?|notify|news(letter)?|mailer-daemon|bounce[s]?|info-noreply)([+.\-_].*)?@/i

export function isBulkMail(headers: Map<string, unknown>, from: string): boolean {
  if (BULK_HEADERS.some(h => headers.has(h))) return true
  const str = (k: string) => {
    const v = headers.get(k)
    return typeof v === 'string' ? v.toLowerCase() : ''
  }
  if (/^(bulk|list|junk)\b/.test(str('precedence'))) return true
  const auto = str('auto-submitted')
  if (auto && !auto.startsWith('no')) return true
  if (BULK_MAILER.test(`${str('x-mailer')} ${str('x-campaign-platform')}`)) return true
  return BULK_SENDER.test(from)
}

export function isListMail(headers: Map<string, unknown>): boolean {
  if (headers.has('list-unsubscribe') || headers.has('list-id')) return true
  const p = headers.get('precedence')
  return typeof p === 'string' && /^(bulk|list)\b/i.test(p)
}

export async function parseMail(source: Buffer): Promise<ParsedMail> {
  const { simpleParser } = await import('mailparser')
  const p = await simpleParser(source)
  const from = p.from?.value?.[0]
  const to = Array.isArray(p.to) ? p.to[0] : p.to
  const address = (from?.address ?? '').toLowerCase()
  return {
    messageId: p.messageId ?? null,
    inReplyTo: typeof p.inReplyTo === 'string' ? p.inReplyTo : null,
    references: (Array.isArray(p.references) ? p.references : p.references ? p.references.split(/\s+/) : []).filter(Boolean),
    bulk: isBulkMail(p.headers as Map<string, unknown>, address),
    list: isListMail(p.headers as Map<string, unknown>),
    from: address,
    fromName: from?.name || null,
    to: (to?.value?.[0]?.address ?? '').toLowerCase(),
    subject: p.subject ?? '',
    text: (p.text ?? '').slice(0, 20_000),
    date: p.date ?? now(),
  }
}

function stripQuote(text: string): string {
  const lines = text.split(/\r?\n/)
  const cut = lines.findIndex(l => /^>/.test(l) || /^(am|on) .{5,80}(schrieb|wrote).{0,40}:$/i.test(l.trim()) || /^-{2,}\s*(original|ursprüngliche)/i.test(l))
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim()
}

async function findTaskFor(db: Db, project: Project, mail: ParsedMail): Promise<{ task: Task | null, direct: boolean }> {
  const refs = [...new Set([mail.inReplyTo, ...mail.references].filter((r): r is string => !!r))]
  if (refs.length) {
    const outs = await db.select({ taskId: schema.mails.taskId }).from(schema.mails).where(and(eq(schema.mails.projectId, project.id), eq(schema.mails.direction, 'out'), inArray(schema.mails.messageId, refs))).orderBy(desc(schema.mails.createdAt))
    if (outs.length) {
      const taskId = outs.find(o => o.taskId)?.taskId
      return { task: taskId ? (await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0] ?? null : null, direct: true }
    }
  }
  if (mail.bulk) return { task: null, direct: false }
  const rows = await db.select({ task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.projectId, project.id), eq(schema.drafts.kind, 'mail'), inArray(schema.tasks.status, ['wartet', 'erledigt', 'freigegeben']), sql`lower(${schema.drafts.recipient}) like ${`%${mail.from}%`}`))
    .orderBy(desc(schema.tasks.updatedAt)).limit(1)
  return { task: rows[0]?.task ?? null, direct: false }
}

export interface SyncResult {
  fetched: number
  replies: number
  codes: number
  errors: string[]
}

export type SyncDeps = TriageDeps

interface Incoming {
  uid: number
  mid: string
  mail: ParsedMail
  code: string | null
  link: string | null
  contact: typeof schema.contacts.$inferSelect | null
  task: Task | null
  direct: boolean
  category: MailCat | null
  by: 'regel' | 'ki' | 'mensch'
  note: string | null
  service: string | null
  known: boolean
}

const SEEN_CATS: MailCat[] = ['info', 'newsletter', 'spam']

export async function syncProjectMail(db: Db, ws: Workspace, project: Project, backend: MailBackend = realBackend, deps: SyncDeps = {}): Promise<SyncResult> {
  const out: SyncResult = { fetched: 0, replies: 0, codes: 0, errors: [] }
  const m = project.setup?.mail
  if (!m) return out
  const pw = openMailPasswords(ws.id, project.id, m)
  if (!pw) {
    out.errors.push(`${project.name}: Passwort unlesbar`)
    return out
  }
  let res
  try {
    res = await backend.fetchNew(m.imap, pw.imap, { uid: m.lastUid ?? null, uidValidity: m.uidValidity ?? null, sinceDate: new Date(now().getTime() - 7 * 86_400_000) })
  }
  catch (err) {
    const e = cleanErr(err, pw)
    await setMail(db, project, { error: `IMAP: ${e}` })
    out.errors.push(`${project.name}: ${e}`)
    return out
  }
  const own = addressOf(m.from)
  const rules = m.rules ?? {}
  let lastUid = m.lastUid ?? 0
  const items: Incoming[] = []
  for (const f of res.messages) {
    lastUid = Math.max(lastUid, f.uid)
    let mail: ParsedMail
    try {
      mail = await parseMail(f.source)
    }
    catch {
      continue
    }
    if (!mail.from || mail.from === own) continue
    const messageId = mail.messageId ?? `uid-${res.uidValidity}-${f.uid}`
    const [known] = await db.select({ id: schema.mails.id }).from(schema.mails).where(and(eq(schema.mails.projectId, project.id), eq(schema.mails.messageId, messageId))).limit(1)
    if (known) continue
    const { code, link } = extractCode(mail.subject, mail.text)
    const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ws.id), sql`lower(${schema.contacts.email}) = ${mail.from}`)).limit(1)
    const { task, direct } = await findTaskFor(db, project, mail)
    const it: Incoming = { uid: f.uid, mid: messageId, mail, code, link, contact: contact ?? null, task, direct, category: null, by: 'regel', note: null, service: accountService(mail), known: !!(task || contact) }
    const rule = rules[mail.from]
    if (rule && isMailCat(rule)) {
      it.category = rule
      it.by = 'mensch'
    }
    else if (direct) {
      it.category = 'antwort'
    }
    else {
      const r = it.known && !mail.bulk ? null : ruleCategory(mail, { code, link })
      if (r) {
        it.category = r.category
        it.note = r.note
      }
    }
    items.push(it)
  }
  const open = items.filter(i => !i.category)
  const triaged = await triageMails(project, open.map((i, k) => ({ i: k, from: i.mail.from, fromName: i.mail.fromName, subject: i.mail.subject, text: stripQuote(i.mail.text), bulk: i.mail.bulk, list: i.mail.list, known: i.known, selfAddressed: !!i.mail.to && i.mail.to.toLowerCase().includes(i.mail.from) } satisfies TriageInput)), deps)
  open.forEach((i, k) => {
    const r = triaged.get(k)
    // Ohne KI bleibt eine unbekannte Mail ungelesen und steht unter "wichtig", es entsteht keine Aufgabe.
    // Bekannte Kontakte ohne KI: wie bisher "braucht Antwort", außer bei Rundmails.
    i.category = r?.category ?? (i.known && !i.mail.bulk ? 'antwort' : 'wichtig')
    i.by = r ? 'ki' : 'regel'
    i.note = r?.note ?? null
    i.service = i.service ?? r?.service ?? null
  })
  const seen: number[] = []
  for (const it of items) {
    const { mail, code, link, task, contact, direct } = it
    out.fetched++
    const category = it.category!
    const kind = category === 'antwort' ? 'reply' : code || link ? 'code' : 'other'
    const inserted = await db.insert(schema.mails).values({
      workspaceId: ws.id,
      projectId: project.id,
      direction: 'in',
      status: 'empfangen',
      kind,
      messageId: it.mid,
      inReplyTo: mail.inReplyTo,
      fromAddr: mail.from,
      fromName: mail.fromName?.slice(0, 200) ?? null,
      toAddr: mail.to,
      subject: mail.subject.slice(0, 500),
      body: mail.text,
      code,
      link,
      sentAt: mail.date,
      contactId: contact?.id ?? null,
      taskId: task?.id ?? null,
      category,
      categoryBy: it.by,
      note: it.note,
    }).onConflictDoNothing().returning()
    const row = inserted[0]
    if (!row) continue
    if (SEEN_CATS.includes(category)) seen.push(it.uid)
    if (it.service && category !== 'spam' && category !== 'antwort') await rememberAccount(db, project.id, it.service, mail.fromName, mail.subject, mail.date, ws.timezone)
    if (kind === 'code') {
      out.codes++
      await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'agent', action: 'mail_code', detail: { title: `${mail.from.split('@')[1] ?? mail.from}: ${code ?? 'Bestätigungslink'}`, code, link, subject: mail.subject.slice(0, 200) }, at: now() })
      continue
    }
    if (kind !== 'reply') continue
    out.replies++
    const prio = direct || /^\s*(re|aw|antw)\s*:/i.test(mail.subject) ? 'P1' : 'P2'
    await handleReply(db, ws, project, row, mail, task, contact, prio)
  }
  if (seen.length && markSeenOn(m) && res.uidValidity) {
    try {
      await backend.markSeen(m.imap, pw.imap, seen, res.uidValidity)
    }
    catch (err) {
      console.error(`[mail] Als gelesen markieren fehlgeschlagen (${project.id}): ${cleanErr(err, pw, 'imap')}`)
    }
  }
  await setMail(db, project, { lastUid: lastUid || null, uidValidity: res.uidValidity || m.uidValidity || null, lastSync: now().toISOString(), error: null })
  return out
}

async function handleReply(db: Db, ws: Workspace, project: Project, row: typeof schema.mails.$inferSelect, mail: ParsedMail, task: Task | null, contact: typeof schema.contacts.$inferSelect | null, prio: Prio): Promise<void> {
  const snippet = stripQuote(mail.text).slice(0, 400)
  const who = contact?.name && contact.name !== contact.email ? contact.name : mail.fromName || mail.from
  if (contact && contact.name === contact.email && mail.fromName) await db.update(schema.contacts).set({ name: mail.fromName }).where(eq(schema.contacts.id, contact.id))
  let c = contact
  if (!c) {
    c = (await db.insert(schema.contacts).values({ workspaceId: ws.id, projectId: project.id, name: who, email: mail.from, source: task ? 'Antwort per Mail' : 'Mail an das Projekt', legalBasis: task ? 'Antwort auf eigene Anfrage' : 'Eingehende Anfrage', status: 'warm' }).returning())[0] ?? null
    await db.update(schema.mails).set({ contactId: c!.id }).where(eq(schema.mails.id, row.id))
  }
  else if (c.status !== 'gesperrt' && c.status !== 'warm') {
    await db.update(schema.contacts).set({ status: 'warm' }).where(eq(schema.contacts.id, c.id))
  }
  if (task) {
    if (task.status === 'wartet' || task.status === 'freigegeben') await updateTask(db, task, { status: 'erledigt', followUpOn: null }, { type: 'agent' })
    else if (task.followUpOn) await db.update(schema.tasks).set({ followUpOn: null }).where(eq(schema.tasks.id, task.id))
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Antwort von ${who}: ${mail.subject}\n${snippet}`, createdAt: now() })
    await db.insert(schema.interactions).values({ contactId: c!.id, taskId: task.id, kind: 'antwort', happenedOn: today(ws.timezone), note: mail.subject.slice(0, 300) })
  }
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, taskId: task?.id ?? null, actor: 'agent', action: 'mail_reply', detail: { title: `${who}: ${mail.subject}`.slice(0, 200), blocked: c?.status === 'gesperrt' }, at: now() })
  if (c?.status === 'gesperrt') return
  const reply = await createTask(db, {
    workspaceId: ws.id,
    projectId: project.id,
    title: `Antwort an ${who}: ${mail.subject}`.slice(0, 200),
    description: `Eingegangene Mail von ${who} <${mail.from}>, Betreff "${mail.subject}":\n${stripQuote(mail.text).slice(0, 3000)}`,
    category: task && task.category !== 'outreach' ? task.category : 'pflege',
    dueDate: today(ws.timezone),
    prio,
    agentStep: 'Antwort entwerfen (kurz, persönlich, auf die Mail eingehen)',
    humanStep: 'Prüfen und senden',
    draftKind: 'mail',
    dependsOnId: task?.id ?? null,
  })
  await db.update(schema.mails).set({ taskId: task?.id ?? reply.id }).where(eq(schema.mails.id, row.id))
  await db.insert(schema.taskNotes).values({ taskId: reply.id, byAgent: true, text: `Antwort geht an ${mail.from}${mail.messageId ? ` (als Antwort auf ${mail.messageId})` : ''}.`, createdAt: now() })
  await db.insert(schema.mails).values({ workspaceId: ws.id, projectId: project.id, direction: 'in', status: 'empfangen', kind: 'reply', messageId: null, inReplyTo: mail.messageId, fromAddr: mail.from, toAddr: mail.to || null, sentAt: mail.date, subject: mail.subject.slice(0, 500), taskId: reply.id, contactId: c!.id })
  await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: reply.id }, dedupeKey: `draft_task:${reply.id}:${today(ws.timezone)}` })
}

export async function replyContext(db: Db, taskId: string): Promise<{ to: string, inReplyTo: string | null, subject: string | null } | null> {
  const [m] = await db.select().from(schema.mails).where(and(eq(schema.mails.taskId, taskId), eq(schema.mails.direction, 'in'))).orderBy(desc(schema.mails.createdAt)).limit(1)
  if (!m?.fromAddr) return null
  return { to: m.fromAddr, inReplyTo: m.inReplyTo ?? m.messageId, subject: m.subject ? (/^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`) : null }
}

export interface MailInfo {
  from: string
  fromName: string | null
  to: string | null
  subject: string | null
  date: string | null
  fetchedAt: string
  messageId: string | null
  inReplyTo: string | null
  earlier: { direction: 'in' | 'out', at: string, subject: string | null, task: string | null }[]
}

// Eingegangene Mail einer Aufgabe mit Metadaten und früheren Mails an/von derselben Adresse
export async function mailInfo(db: Db, taskId: string, limit = 8): Promise<MailInfo | null> {
  const rows = await db.select().from(schema.mails).where(and(eq(schema.mails.taskId, taskId), eq(schema.mails.direction, 'in'), isNotNull(schema.mails.fromAddr))).orderBy(desc(schema.mails.createdAt)).limit(5)
  const stub = rows[0]
  if (!stub?.fromAddr) return null
  let orig = stub.messageId ? stub : rows.find(r => r.messageId && r.messageId === stub.inReplyTo) ?? null
  if (!orig && stub.inReplyTo && stub.projectId) orig = (await db.select().from(schema.mails).where(and(eq(schema.mails.projectId, stub.projectId), eq(schema.mails.direction, 'in'), eq(schema.mails.messageId, stub.inReplyTo))).limit(1))[0] ?? null
  const m = orig ?? stub
  const from = m.fromAddr ?? stub.fromAddr
  const cid = m.contactId ?? stub.contactId
  const contact = cid ? (await db.select({ name: schema.contacts.name }).from(schema.contacts).where(eq(schema.contacts.id, cid)))[0] ?? null : null
  const date = m.sentAt ?? stub.sentAt
  const ownId = orig?.messageId ?? stub.inReplyTo
  const earlier: MailInfo['earlier'] = []
  if (stub.projectId) {
    const prev = await db.select({ m: schema.mails, code: schema.tasks.code }).from(schema.mails).leftJoin(schema.tasks, eq(schema.tasks.id, schema.mails.taskId)).where(and(
      eq(schema.mails.projectId, stub.projectId),
      sql`((${schema.mails.direction} = 'in' and lower(${schema.mails.fromAddr}) = ${from.toLowerCase()} and ${schema.mails.messageId} is not null) or (${schema.mails.direction} = 'out' and ${schema.mails.status} = 'gesendet' and lower(${schema.mails.toAddr}) = ${from.toLowerCase()}))`,
    )).orderBy(desc(sql`coalesce(${schema.mails.sentAt}, ${schema.mails.createdAt})`)).limit(limit + 1)
    for (const p of prev) {
      if (p.m.id === m.id || (ownId && p.m.messageId === ownId)) continue
      earlier.push({ direction: p.m.direction, at: (p.m.sentAt ?? p.m.createdAt).toISOString(), subject: p.m.subject, task: p.code ?? null })
    }
  }
  return {
    from,
    fromName: contact?.name && contact.name.toLowerCase() !== from.toLowerCase() ? contact.name : null,
    to: m.toAddr ?? stub.toAddr ?? null,
    subject: m.subject ?? stub.subject,
    date: date ? date.toISOString() : null,
    fetchedAt: stub.createdAt.toISOString(),
    messageId: ownId ?? null,
    inReplyTo: orig ? orig.inReplyTo : null,
    earlier: earlier.slice(0, limit),
  }
}

function fmtAt(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('de-AT', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
}

// Textblock für Prompts (Chat, Entwurf, Nachprüfung)
export function mailInfoText(i: MailInfo, tz: string): string {
  const who = i.fromName ? `${i.fromName} <${i.from}>` : i.from
  const lines = [
    `Eingegangene Mail (Daten aus dem Projekt-Postfach): von ${who}${i.to ? ` an ${i.to}` : ''}`,
    i.date ? `Datum der Mail: ${fmtAt(i.date, tz)}` : `Datum der Mail: nicht gespeichert (in Aimarage abgerufen am ${fmtAt(i.fetchedAt, tz)})`,
    i.subject ? `Betreff: ${i.subject}` : '',
    i.messageId ? `Message-ID: ${i.messageId}` : '',
    i.inReplyTo ? `Antwort auf: ${i.inReplyTo}` : '',
    i.earlier.length
      ? `Frühere Mails mit ${i.from}:\n${i.earlier.map(e => `- ${fmtAt(e.at, tz)} ${e.direction === 'in' ? 'erhalten' : 'gesendet (unsere Antwort)'}: ${e.subject ?? '(ohne Betreff)'}${e.task ? ` [${e.task}]` : ''}`).join('\n')}`
      : `Frühere Mails mit ${i.from}: keine`,
  ]
  return lines.filter(Boolean).join('\n')
}

export async function mailAllowed(db: Db, task: Pick<Task, 'id' | 'category' | 'draftKind' | 'title' | 'description' | 'targetUrl' | 'dependsOnId'>, depth = 0): Promise<boolean> {
  if (!mailRelevant(task)) return true
  if (await replyContext(db, task.id)) return true
  const notes = await db.select({ text: schema.taskNotes.text }).from(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, task.id), eq(schema.taskNotes.byAgent, false)))
  if (submissionSource([task.title, task.description, ...notes.map(n => n.text)], task.targetUrl)) return true
  if (!task.dependsOnId || depth >= 2) return false
  const [parent] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.dependsOnId))
  return !!parent && mailRelevant(parent) && mailAllowed(db, parent, depth + 1)
}

export async function dropColdMail(db: Db, ws: Workspace, task: Pick<Task, 'id' | 'projectId' | 'title' | 'status'>): Promise<boolean> {
  if (!OPEN_STATUSES.includes(task.status) || task.status === 'wartet') return false
  await db.transaction(async (tx) => {
    await tx.update(schema.drafts).set({ status: 'verworfen' }).where(and(eq(schema.drafts.taskId, task.id), eq(schema.drafts.status, 'offen')))
    await tx.update(schema.tasks).set({ status: 'verworfen', updatedAt: now() }).where(eq(schema.tasks.id, task.id))
    await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: COLD_MAIL_TEXT, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'cold_mail_dropped', detail: { title: task.title }, at: now() })
  })
  return true
}

export async function dropColdMails(db: Db, ws: Workspace): Promise<number> {
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    eq(schema.tasks.status, 'geplant'),
    sql`(${schema.tasks.draftKind} = 'mail' or ${schema.tasks.category} = 'outreach')`,
    sql`not exists (select 1 from drafts where drafts.task_id = ${schema.tasks.id} and drafts.status in ('offen', 'freigegeben'))`,
  ))
  let n = 0
  for (const t of rows) if (!(await mailAllowed(db, t)) && await dropColdMail(db, ws, t)) n++
  return n
}

export function mailReady(project: Pick<Project, 'setup'> | null): boolean {
  return !!project?.setup?.mail?.smtp?.host
}

export function singleRecipient(raw: string | null | undefined): string {
  const list = (raw ?? '').split(/[,;]+/).map(s => s.trim()).filter(Boolean)
  if (list.length !== 1 || (list[0]!.match(/@/g)?.length ?? 0) > 1) throw new MailError(list.length ? 'Nur ein Empfänger pro Mail (kein Massenversand)' : 'Empfänger fehlt')
  const a = addressOf(list[0]!)
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a)) throw new MailError(`Ungültige Adresse: ${a}`)
  return a
}

// Mails gehen nie automatisch raus: jede Mail braucht den Klick eines Menschen auf "Senden", egal welche Freigabe-Stufe.
export const AUTO_MAIL_ALLOWED = false

export function decideSend(project: Pick<Project, 'autonomy' | 'setup'>, task: Pick<Task, 'category' | 'draftKind'>): { action: 'approve' } | { action: 'send', report: boolean } {
  if (!AUTO_MAIL_ALLOWED || !mailReady(project) || task.draftKind !== 'mail') return { action: 'approve' }
  const a = effectiveAutonomy(project.autonomy ?? {}, task.category, 'mail')
  if (a.fixed || a.level === 'approve') return { action: 'approve' }
  return { action: 'send', report: a.level === 'auto_report' }
}

export const HUMAN_ONLY = 'Mails gehen nur nach dem Klick eines Menschen auf "Senden" raus, nie automatisch'

export async function scheduleSend(db: Db, ws: Workspace, input: { task: Task, draft: Draft, project: Project, mode: 'auto' | 'auto_report', at: Date }): Promise<string> {
  if (!AUTO_MAIL_ALLOWED) throw new MailError(HUMAN_ONLY, 'human_only')
  if (hasPlaceholder(`${input.draft.subject ?? ''}\n${input.draft.body}`)) throw new MailError('Platzhalter im Text, bitte erst ausfüllen')
  const to = singleRecipient(input.draft.recipient)
  const [row] = await db.insert(schema.mails).values({ workspaceId: ws.id, projectId: input.project.id, direction: 'out', status: 'geplant', kind: 'other', toAddr: to, subject: input.draft.subject, taskId: input.task.id, draftId: input.draft.id, mode: input.mode, scheduledAt: input.at }).returning()
  await enqueueJob(db, 'send_mail', { workspaceId: ws.id, payload: { mailId: row!.id, taskId: input.task.id }, dedupeKey: `send_mail:${row!.id}`, runAt: input.at, maxAttempts: 1 })
  await logActivity(db, { workspaceId: ws.id, projectId: input.project.id, taskId: input.task.id, actor: 'agent', action: 'mail_scheduled', detail: { title: input.task.title, to }, at: now() })
  return row!.id
}

export async function sendDraft(db: Db, ws: Workspace, input: { draftId: string, userId?: string | null, mode: 'manual' | 'auto' | 'auto_report', mailId?: string | null, resend?: boolean }, backend: MailBackend = realBackend): Promise<{ status: 'gesendet' | 'trocken', to: string }> {
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId)).where(and(eq(schema.drafts.id, input.draftId), eq(schema.tasks.workspaceId, ws.id)))
  if (!row) throw new MailError('Entwurf nicht gefunden')
  const { draft, task } = row
  if (draft.kind !== 'mail') throw new MailError('Kein Mail-Entwurf')
  if (hasPlaceholder(`${draft.subject ?? ''}\n${draft.body}`)) throw new MailError('Platzhalter im Text, bitte erst ausfüllen')
  if (input.mode !== 'manual' || !input.userId) throw new MailError(HUMAN_ONLY, 'human_only')
  const internal = internalTextProblems([draft.subject, draft.body])
  if (internal.length) throw new MailError(`Nicht gesendet: ${internal.join('; ')}. Bitte den Text anpassen.`, 'internal_text')
  if (input.mode !== 'manual' && (task.category === 'outreach' || task.category === 'community')) throw new MailError('Kaltakquise und Community werden nie automatisch gesendet')
  if (!(await mailAllowed(db, task))) throw new MailError('Keine Kaltmails: Mails gehen nur als Antwort auf eine eingegangene Mail oder an Adressen, die ausdrücklich um Einsendungen bitten (Quelle als Link vermerken).')
  if (input.mode === 'manual' ? !['offen', 'freigegeben'].includes(draft.status) : draft.status !== 'freigegeben') throw new MailError(`Entwurf ist ${draft.status}`)
  const resend = !!input.resend && input.mode === 'manual'
  if (!resend && await alreadySent(db, draft.id, task)) throw new MailError(ALREADY_SENT, 'already_sent')
  const project = task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  const m = project?.setup?.mail
  if (!project || !m) throw new MailError('Für dieses Projekt ist kein Postfach eingetragen (Projekt > Konten)')
  const to = singleRecipient(draft.recipient)
  const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ws.id), sql`lower(${schema.contacts.email}) = ${to}`)).limit(1)
  if (contact?.status === 'gesperrt') throw new MailError(`${contact.name} ist gesperrt, keine Mails an diesen Kontakt`)
  const ctx = await replyContext(db, task.id)
  const subject = draft.subject || ctx?.subject || task.title
  const actor = input.userId ? { type: 'user' as const, userId: input.userId } : { type: 'agent' as const }
  if (!ws.settings?.sendLive) {
    if (input.mailId) await db.update(schema.mails).set({ status: 'trocken' }).where(eq(schema.mails.id, input.mailId))
    else await db.insert(schema.mails).values({ workspaceId: ws.id, projectId: project.id, direction: 'out', status: 'trocken', toAddr: to, subject, taskId: task.id, draftId: draft.id, mode: input.mode })
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: !input.userId, userId: input.userId ?? null, text: `Trockenlauf: würde jetzt an ${to} senden ("${subject}"). "Senden nach außen" ist aus, es wurde nichts gesendet.`, createdAt: now() })
    await logActivity(db, { workspaceId: ws.id, projectId: project.id, taskId: task.id, actor: actor.type, userId: input.userId ?? null, action: 'mail_dry_run', detail: { title: task.title, to }, at: now() })
    return { status: 'trocken', to }
  }
  const pw = openMailPasswords(ws.id, project.id, m)
  if (!pw) throw new MailError('Postfach-Passwort unlesbar, bitte neu eintragen')
  let sent
  try {
    sent = (await withSmtpFallback(db, ws, project, m, cfg => backend.send(cfg, pw.smtp, { from: m.from, to, subject, text: draft.body, inReplyTo: ctx?.inReplyTo ?? null, ...(draft.aiGenerated ? { aiGenerated: true } : {}) }), input.userId ?? null)).result
  }
  catch (err) {
    const e = cleanErr(err, pw)
    if (input.mailId) await db.update(schema.mails).set({ status: 'fehler', error: e }).where(eq(schema.mails.id, input.mailId))
    throw new MailError(`Senden fehlgeschlagen: ${e}`, mailServerUnreachable(err) ? 'smtp_unreachable' : null)
  }
  backend.appendSent(m.imap, pw.imap, sent.raw).catch(err => console.error(`[mail] Ablage im Gesendet-Ordner fehlgeschlagen (${project.id}): ${cleanErr(err, pw)}`))
  const values = { status: 'gesendet' as const, messageId: sent.messageId, inReplyTo: ctx?.inReplyTo ?? null, fromAddr: addressOf(m.from), toAddr: to, subject, body: draft.body, sentAt: now() }
  if (input.mailId) await db.update(schema.mails).set(values).where(eq(schema.mails.id, input.mailId))
  else await db.insert(schema.mails).values({ ...values, workspaceId: ws.id, projectId: project.id, direction: 'out', taskId: task.id, draftId: draft.id, mode: input.mode })
  if (resend) {
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: false, userId: input.userId ?? null, text: `Erneut gesendet an ${to}: "${subject}"`, createdAt: now() })
    await logActivity(db, { workspaceId: ws.id, projectId: project.id, taskId: task.id, actor: actor.type, userId: input.userId ?? null, action: 'mail_resent', detail: { title: task.title, to }, at: now() })
    return { status: 'gesendet', to }
  }
  await db.transaction(async (tx) => {
    if (draft.status === 'offen') await tx.update(schema.drafts).set({ status: 'freigegeben', approvedByUserId: input.userId ?? null, approvedAt: now() }).where(eq(schema.drafts.id, draft.id))
    const [cur] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    const isReply = !!ctx
    if (cur && !['erledigt', 'ausgewertet', 'verworfen'].includes(cur.status)) await updateTask(tx as unknown as Db, cur, isReply ? { status: 'erledigt' } : { status: 'wartet', followUpOn: cur.followUpOn ?? addDays(today(ws.timezone), 7) }, actor)
    await tx.update(schema.tasks).set({ doneAt: now() }).where(eq(schema.tasks.id, task.id))
    if (contact) await tx.update(schema.contacts).set({ status: contact.status === 'neu' ? 'kontaktiert' : contact.status }).where(eq(schema.contacts.id, contact.id))
    else await tx.insert(schema.contacts).values({ workspaceId: ws.id, projectId: project.id, name: to, email: to, source: 'Mail aus dem Tool', status: 'kontaktiert' })
    await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: !input.userId, userId: input.userId ?? null, text: `Gesendet an ${to}: "${subject}"`, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: project.id, taskId: task.id, actor: actor.type, userId: input.userId ?? null, action: input.mode === 'auto_report' ? 'mail_sent_report' : 'mail_sent', detail: { title: task.title, to }, at: now() })
  })
  return { status: 'gesendet', to }
}

export const ALREADY_SENT = 'Schon gesendet'

export function taskFinished(task: Pick<Task, 'status' | 'doneAt'>): boolean {
  return !!task.doneAt && ['wartet', 'erledigt', 'ausgewertet'].includes(task.status)
}

export async function sentInfo(db: Db, draftId: string): Promise<{ to: string | null, at: string } | null> {
  const [m] = await db.select({ to: schema.mails.toAddr, at: schema.mails.sentAt, createdAt: schema.mails.createdAt }).from(schema.mails).where(and(eq(schema.mails.draftId, draftId), eq(schema.mails.direction, 'out'), eq(schema.mails.status, 'gesendet'))).orderBy(desc(schema.mails.createdAt)).limit(1)
  return m ? { to: m.to, at: (m.at ?? m.createdAt).toISOString() } : null
}

async function alreadySent(db: Db, draftId: string, task: Pick<Task, 'status' | 'doneAt'>): Promise<boolean> {
  if (taskFinished(task)) return true
  const [m] = await db.select({ id: schema.mails.id }).from(schema.mails).where(and(eq(schema.mails.draftId, draftId), eq(schema.mails.direction, 'out'), eq(schema.mails.status, 'gesendet'))).limit(1)
  return !!m
}

export async function runScheduledSend(db: Db, ws: Workspace, mailId: string, backend: MailBackend = realBackend): Promise<{ status: 'ok' | 'skipped' | 'error', summary: string }> {
  const [row] = await db.select().from(schema.mails).where(and(eq(schema.mails.id, mailId), eq(schema.mails.workspaceId, ws.id), eq(schema.mails.status, 'geplant')))
  if (!row?.draftId || !row.taskId) return { status: 'skipped', summary: 'Mail nicht mehr geplant' }
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, row.taskId))
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, row.draftId))
  if (!task || !draft || draft.status !== 'freigegeben' || task.status !== 'freigegeben') {
    await db.update(schema.mails).set({ status: 'abgebrochen' }).where(eq(schema.mails.id, mailId))
    return { status: 'skipped', summary: 'Abgebrochen: Entwurf oder Aufgabe geändert' }
  }
  const late = row.scheduledAt ? (now().getTime() - row.scheduledAt.getTime()) / 3_600_000 : 0
  try {
    if (late > LATE_HOURS) throw new MailError(`Zeitpunkt um ${Math.round(late)} Stunden verpasst, nicht automatisch nachgeholt`)
    const r = await sendDraft(db, ws, { draftId: draft.id, mode: row.mode ?? 'auto', mailId }, backend)
    return { status: 'ok', summary: r.status === 'trocken' ? `Trockenlauf: würde an ${r.to} senden` : `Gesendet an ${r.to}` }
  }
  catch (err) {
    const msg = (err as Error).message
    await db.update(schema.mails).set({ status: 'fehler', error: msg.slice(0, 500) }).where(eq(schema.mails.id, mailId))
    await db.update(schema.drafts).set({ status: 'offen', approvedAt: null }).where(eq(schema.drafts.id, draft.id))
    const owner = (await db.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, ws.id), eq(schema.memberships.role, 'owner'))).limit(1))[0]?.u ?? null
    await updateTask(db, task, { status: 'entwurf_fertig', assigneeUserId: owner ?? task.assigneeUserId }, { type: 'agent' })
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Mail nicht gesendet: ${msg}. Bitte prüfen und selbst senden.`, createdAt: now() })
    await logActivity(db, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: 'mail_failed', detail: { title: task.title, error: msg.slice(0, 300) }, at: now() })
    return { status: 'error', summary: msg }
  }
}

export async function syncAllMail(db: Db, ws: Workspace, backend: MailBackend = realBackend, deps: SyncDeps = {}): Promise<SyncResult & { projects: number }> {
  const projects = (await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))).filter(p => p.setup?.mail && !p.archivedAt)
  const total = { fetched: 0, replies: 0, codes: 0, errors: [] as string[], projects: projects.length }
  for (const p of projects) {
    const r = await syncProjectMail(db, ws, p, backend, deps)
    total.fetched += r.fetched
    total.replies += r.replies
    total.codes += r.codes
    total.errors.push(...r.errors)
  }
  return total
}

export class InboxError extends Error {}

// Einordnung von Hand korrigieren: gilt künftig als Regel für den Absender. "braucht Antwort" legt die Antwort-Aufgabe an,
// weg von "braucht Antwort" verwirft eine noch offene Antwort-Aufgabe ohne Versand.
export async function correctMail(db: Db, ws: Workspace, mailId: string, category: MailCat, userId: string): Promise<{ taskId: string | null, dropped: boolean }> {
  const [row] = await db.select().from(schema.mails).where(and(eq(schema.mails.id, mailId), eq(schema.mails.workspaceId, ws.id), eq(schema.mails.direction, 'in'), isNotNull(schema.mails.messageId)))
  if (!row?.projectId || !row.fromAddr) throw new InboxError('Mail nicht gefunden')
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, row.projectId))
  if (!project?.setup?.mail) throw new InboxError('Für dieses Projekt ist kein Postfach eingetragen')
  const from = row.fromAddr.toLowerCase()
  await setMail(db, project, { rules: { ...(project.setup.mail.rules ?? {}), [from]: category } })
  const before = row.category
  await db.update(schema.mails).set({ category, categoryBy: 'mensch', note: category === 'wichtig' ? row.note : null }).where(eq(schema.mails.id, row.id))
  await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'user', userId, action: 'mail_category', detail: { title: `${from}: ${row.subject ?? ''}`.slice(0, 200), from: before, to: category } })
  if (before === category) return { taskId: null, dropped: false }
  const replyTasks = async () => {
    const ids = (await db.select({ taskId: schema.mails.taskId }).from(schema.mails).where(and(eq(schema.mails.projectId, project.id), eq(schema.mails.direction, 'in'), sql`${schema.mails.messageId} is null`, eq(schema.mails.inReplyTo, row.messageId!)))).map(r => r.taskId).filter((x): x is string => !!x)
    return ids.length ? db.select().from(schema.tasks).where(inArray(schema.tasks.id, ids)) : []
  }
  if (category === 'antwort') {
    if ((await replyTasks()).length) return { taskId: null, dropped: false }
    const mail: ParsedMail = { messageId: row.messageId, inReplyTo: row.inReplyTo, references: [], bulk: false, list: false, from, fromName: row.fromName, to: row.toAddr ?? '', subject: row.subject ?? '', text: row.body ?? '', date: row.sentAt ?? row.createdAt }
    const { task, direct } = await findTaskFor(db, project, mail)
    const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ws.id), sql`lower(${schema.contacts.email}) = ${from}`)).limit(1)
    await db.update(schema.mails).set({ kind: 'reply' }).where(eq(schema.mails.id, row.id))
    await handleReply(db, ws, project, row, mail, task, contact ?? null, direct ? 'P1' : 'P2')
    const created = (await replyTasks())[0]
    return { taskId: created?.id ?? null, dropped: false }
  }
  if (before !== 'antwort') return { taskId: null, dropped: false }
  return { taskId: null, dropped: await dropReplyTasks(db, project.id, row.messageId!, userId, 'Keine Antwort nötig: Mail im Postfach anders eingeordnet.') }
}

// Offene Antwort-Aufgaben zu einer Mail verwerfen, ohne etwas zu senden (schon gesendete bleiben).
async function dropReplyTasks(db: Db, projectId: string, messageId: string, userId: string, note: string): Promise<boolean> {
  const ids = (await db.select({ taskId: schema.mails.taskId }).from(schema.mails).where(and(eq(schema.mails.projectId, projectId), eq(schema.mails.direction, 'in'), sql`${schema.mails.messageId} is null`, eq(schema.mails.inReplyTo, messageId)))).map(r => r.taskId).filter((x): x is string => !!x)
  if (!ids.length) return false
  let dropped = false
  for (const t of await db.select().from(schema.tasks).where(inArray(schema.tasks.id, ids))) {
    if (!OPEN_STATUSES.includes(t.status) || t.status === 'wartet' || t.doneAt) continue
    const [sent] = await db.select({ id: schema.mails.id }).from(schema.mails).where(and(eq(schema.mails.taskId, t.id), eq(schema.mails.direction, 'out'), inArray(schema.mails.status, ['gesendet', 'geplant']))).limit(1)
    if (sent) continue
    await db.update(schema.drafts).set({ status: 'verworfen' }).where(and(eq(schema.drafts.taskId, t.id), eq(schema.drafts.status, 'offen')))
    await db.update(schema.tasks).set({ status: 'verworfen', updatedAt: now() }).where(eq(schema.tasks.id, t.id))
    await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: false, userId, text: note, createdAt: now() })
    dropped = true
  }
  return dropped
}

// Nur diese eine Mail als erledigt markieren (oder wieder öffnen). Ändert keine Regel für den Absender und sendet nichts;
// eine offene Antwort-Aufgabe dazu wird verworfen.
export async function markMailDone(db: Db, ws: Workspace, mailId: string, done: boolean, userId: string): Promise<{ dropped: boolean }> {
  const [row] = await db.select().from(schema.mails).where(and(eq(schema.mails.id, mailId), eq(schema.mails.workspaceId, ws.id), eq(schema.mails.direction, 'in'), isNotNull(schema.mails.messageId)))
  if (!row?.projectId) throw new InboxError('Mail nicht gefunden')
  await db.update(schema.mails).set({ status: done ? 'erledigt' : 'empfangen' }).where(eq(schema.mails.id, row.id))
  await logActivity(db, { workspaceId: ws.id, projectId: row.projectId, actor: 'user', userId, action: 'mail_done', detail: { title: `${row.fromAddr ?? ''}: ${row.subject ?? ''}`.slice(0, 200), done } })
  if (!done) return { dropped: false }
  return { dropped: await dropReplyTasks(db, row.projectId, row.messageId!, userId, 'Keine Antwort nötig: Mail im Postfach als erledigt markiert.') }
}
