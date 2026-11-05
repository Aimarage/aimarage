import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { ALL_SLUG } from '../../shared/utils/domain'
import { notableText, type InboxLine } from '../../shared/utils/inbox'
import { forYouNow, viewMinutes } from '../../shared/utils/task-state'
import { INFO_BUNDLE_MIN } from '../../shared/utils/time-budget'
import { minutesOf, timeIn, todayIn } from '../../shared/utils/dates'
import { platformRule } from '../../shared/utils/social'
import { plural } from '../../shared/utils/plural'
import { accessText, type AccessProblem } from '../../shared/utils/access'
import { workspaceAccessProblems } from './access-problems'
import { reviewerReleases } from './ai-reviewer'
import { approvedUntil, shortDay } from './approval-limit'
import { autoNotes } from './auto-strategy'
import { config } from './config'
import { now, nowTime, today } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { inboxSummary } from './inbox'
import { enqueueJob } from './jobs'
import { morningMailOn, unsubscribeHeaders, unsubscribeUrl } from './mail-unsubscribe'
import { notify } from './notify'
import { zonedToUtc } from './publish'
import { queueSystemMail } from './system-mail'
import { openTaskViews, type ViewRow } from './task-view'
import type { TaskRow } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect

// Ruhezeit: vor 07:00 wird die Nachricht auf 07:00 gelegt, ab 21:00 fällt sie für den Tag weg.
export const QUIET_UNTIL = '07:00'
export const QUIET_FROM = '21:00'

export interface DigestItem {
  title: string
  time: string | null
  min: number
  url: string
  // Selbst posten, nachdem Claude bzw. der KI-Prüfer geprüft hat.
  afterCheck?: boolean
  // Zugangsfehler: steht ganz oben, Text je Sprache.
  access?: AccessProblem
}

// Vom KI-Prüfer freigegeben (letzte 24 Stunden): gesammelt in der Tagesmail, mit Link zum Entwurf (dort "Stoppen", Login nötig).
export interface ReviewerDigestItem {
  platform: string | null
  title: string
  day: string | null
  time: string | null
  url: string
  stoppable: boolean
}

export interface Digest {
  userId: string
  minutes: number
  items: DigestItem[]
  inbox?: InboxLine[]
  // Bis wann im Voraus alles freigegeben ist (ISO-Datum).
  approvedUntil?: string | null
  reviewer?: ReviewerDigestItem[]
  // Vom Agenten nach Ergebnissen angepasste Strategie (letzte 24 Stunden), Link führt zum Knopf "Rückgängig".
  strategy?: StrategyDigestItem[]
}

export interface StrategyDigestItem { de: string, en: string, url: string }

// Postfach in der Tagesmail nur mit Mails, die etwas brauchen: offene Antworten ohne eigene Aufgabe, wichtige Mails
// und bedeutsame Benachrichtigungen (Konto, Sicherheit). Reine Benachrichtigungen, Newsletter und Spam nie.
export function actionableInbox(lines: InboxLine[]): InboxLine[] {
  return lines
    .map(l => ({ ...l, notable: (l.notable ?? []).filter(m => !(m.kind === 'antwort' && m.taskId)) }))
    .filter(l => l.notable.length)
}

// Was heute für jede Person dran ist (taskViews: "Du bist dran", inklusive Überfälligem). Rückfragen gebündelt.
export async function morningDigests(db: DbOrTx, ws: Workspace): Promise<Digest[]> {
  const d = today(ws.timezone)
  const rows = (await openTaskViews(db, ws)).filter(r => forYouNow(r.view) && r.view.userId)
  const inbox = actionableInbox(await inboxSummary(db, ws.id, { since: new Date(now().getTime() - 86_400_000) }))
  const out: Digest[] = []
  const access = await workspaceAccessProblems(db, ws)
  const accessItems: DigestItem[] = access.map(a => ({ title: accessText(a, 'de'), time: null, min: a.min, url: `${config.appUrl}${a.path}`, access: a }))
  const accessMin = accessItems.reduce((n, a) => n + a.min, 0)
  const projects = new Map((await db.select({ id: schema.projects.id, slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.workspaceId, ws.id))).map(p => [p.id, p.slug]))
  const released = await reviewerReleases(db, ws.id, { since: new Date(now().getTime() - 86_400_000) })
  const reviewer: ReviewerDigestItem[] = released.map(r => ({
    platform: r.platform,
    title: r.title,
    day: r.releaseAt ? todayIn(ws.timezone, r.releaseAt) : null,
    time: r.releaseAt ? timeIn(ws.timezone, r.releaseAt) : null,
    url: `${config.appUrl}/p/${(r.projectId && projects.get(r.projectId)) || ALL_SLUG}/freigaben/${r.draftId}${r.stoppable ? '?stoppen=1' : ''}`,
    stoppable: r.stoppable,
  }))
  const strategy: StrategyDigestItem[] = (await autoNotes(db, ws.id, new Date(now().getTime() - 86_400_000))).map(n => ({ de: n.text, en: n.textEn, url: `${config.appUrl}/p/${(n.projectId && projects.get(n.projectId)) || ALL_SLUG}` }))
  if (inbox.length || access.length || reviewer.length || strategy.length) {
    const admins = await db.select({ userId: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, ws.id), inArray(schema.memberships.role, ['owner', 'admin'])))
    for (const a of admins) out.push({ userId: a.userId, minutes: accessMin, items: [...accessItems], ...(inbox.length ? { inbox } : {}), ...(reviewer.length ? { reviewer } : {}), ...(strategy.length ? { strategy } : {}) })
  }
  if (!rows.length) return out
  const until = await approvedUntil(db, ws, d)
  const base = (t: TaskRow) => `${config.appUrl}/p/${(t.projectId && projects.get(t.projectId)) || ALL_SLUG}`
  const link = (r: { task: TaskRow, view: ViewRow }) => (r.view.draftId ? `${base(r.task)}/freigaben/${r.view.draftId}` : `${base(r.task)}/aufgaben/${r.task.id}`)
  const byUser = new Map<string, { task: TaskRow, view: ViewRow }[]>()
  for (const r of rows) byUser.set(r.view.userId!, [...(byUser.get(r.view.userId!) ?? []), r])
  for (const [userId, list] of byUser) {
    const sorted = list.sort((a, b) => Number(b.view.overdue) - Number(a.view.overdue) || (a.task.dueTime ?? '99').localeCompare(b.task.dueTime ?? '99') || a.task.prio.localeCompare(b.task.prio) || a.task.code.localeCompare(b.task.code))
    const items: DigestItem[] = sorted.filter(x => x.view.next !== 'answer').map(r => ({
      title: r.task.title,
      ...(r.view.then === 'post' ? { afterCheck: true } : {}),
      time: r.task.dueDate !== d ? null : r.task.dueTime,
      min: r.view.min,
      url: link(r),
    }))
    const info = sorted.filter(x => x.view.next === 'answer')
    if (info.length) items.push({ title: info.length === 1 ? `Rückfrage des Agenten: ${info[0]!.task.title}` : `${info.length} Rückfragen des Agenten (gesammelt)`, time: null, min: INFO_BUNDLE_MIN, url: info.length === 1 ? link(info[0]!) : `${config.appUrl}/p/${ALL_SLUG}/freigaben` })
    const minutes = viewMinutes(list.map(x => x.view), INFO_BUNDLE_MIN)
    const had = out.find(g => g.userId === userId)
    if (had) Object.assign(had, { minutes: had.minutes + minutes, items: [...had.items, ...items], approvedUntil: until && until > d ? until : null })
    else out.push({ userId, minutes, items, approvedUntil: until && until > d ? until : null })
  }
  return out
}

export function reviewerDigestText(list: ReviewerDigestItem[], locale: 'de' | 'en'): string {
  if (!list.length) return ''
  const head = locale === 'en' ? 'Approved by the AI reviewer:' : 'Vom KI-Prüfer freigegeben:'
  const lines = list.map((r) => {
    const when = r.day ? `${shortDay(r.day, locale)}${r.time ? ` ${r.time}` : ''}` : ''
    const meta = [r.platform ? platformRule(r.platform).label : null, when || null].filter(Boolean).join(', ')
    const link = r.stoppable ? `${locale === 'en' ? 'Stop' : 'Stoppen'}: ${r.url}` : `${locale === 'en' ? 'Already out' : 'Schon raus'}: ${r.url}`
    return `- ${r.title}${meta ? ` (${meta})` : ''}\n${link}`
  })
  return [head, ...lines].join('\n')
}

export function digestText(g: Digest, locale: 'de' | 'en'): { subject: string, body: string } {
  const head = locale === 'en' ? `Today for you (about ${g.minutes} min):` : `Heute für dich (ca. ${g.minutes} Min):`
  const after = locale === 'en' ? ' - post it yourself, Claude checks it first' : ' - selbst posten, Claude prüft vorher'
  const lines = g.items.map((it, i) => `${i + 1}. ${it.access ? accessText(it.access, locale) : it.title}${it.time ? ` (${it.time})` : ''}${it.afterCheck ? after : ''}\n${it.url}`)
  const box = (g.inbox ?? []).map(l => [locale === 'en' ? `Mailbox ${l.name}:` : `Postfach ${l.name}:`, ...(l.notable ?? []).slice(0, 3).map(m => notableText(m, locale)), `${config.appUrl}/p/${l.slug}/postfach`].join('\n'))
  const rev = [...(g.strategy ?? []).map(x => `${x[locale]}\n${locale === 'en' ? 'Undo' : 'Rückgängig'}: ${x.url}`), ...(g.reviewer?.length ? [reviewerDigestText(g.reviewer, locale)] : [])]
  if (!g.items.length) {
    const notable = (g.inbox ?? []).flatMap(l => l.notable ?? [])
    const n = notable.length
    if (!n && !g.reviewer?.length && g.strategy?.length) return { subject: (g.strategy.length === 1 ? g.strategy[0]![locale] : locale === 'en' ? `Strategy adjusted in ${g.strategy.length} projects` : `Strategie in ${g.strategy.length} Projekten angepasst`).slice(0, 120), body: rev.join('\n\n') }
    if (!n && rev.length) {
      const k = g.reviewer!.length
      return { subject: locale === 'en' ? `AI reviewer approved ${k === 1 ? '1 post' : `${k} posts`}` : `KI-Prüfer hat ${plural(k, 'Beitrag', 'Beiträge')} freigegeben`, body: rev.join('\n\n') }
    }
    const one = n === 1 ? notable[0]! : null
    const subject = one
      ? `${locale === 'en' ? 'Mailbox' : 'Postfach'}: ${one.from}${one.subject ? ` - ${one.subject}` : ''}`.slice(0, 120)
      : locale === 'en' ? `Mailbox: ${n} mails for you` : `Postfach: ${n} Mails für dich`
    return { subject, body: [...rev, ...box].join('\n\n') }
  }
  const until = g.approvedUntil ? [locale === 'en' ? `Everything is approved up to ${shortDay(g.approvedUntil, 'en')}.` : `Bis ${shortDay(g.approvedUntil, 'de')} ist alles freigegeben.`] : []
  return { subject: locale === 'en' ? `Today for you: about ${g.minutes === 1 ? '1 minute' : `${g.minutes} minutes`}` : `Heute für dich: ca. ${plural(g.minutes, 'Minute', 'Minuten')}`, body: [head, ...lines, ...until, ...rev, ...box].join('\n\n') }
}

export function digestHasContent(g: Digest): boolean {
  return !!(g.items.length || g.inbox?.length || g.reviewer?.length || g.strategy?.length)
}

export interface DigestPart { workspace: string, digest: Digest }

// Eine Mail je Person über alle Arbeitsbereiche: ein Abschnitt je Bereich ("## Name"), Minuten addiert.
// Hat nur ein Bereich etwas, sieht die Mail aus wie bisher.
export function bundleDigestText(parts: DigestPart[], locale: 'de' | 'en'): { subject: string, body: string } | null {
  const live = parts.filter(p => digestHasContent(p.digest))
  if (!live.length) return null
  if (live.length === 1) return digestText(live[0]!.digest, locale)
  const body = live.map(p => `## ${p.workspace}\n\n${digestText(p.digest, locale).body}`).join('\n\n')
  const busy = live.filter(p => p.digest.items.length)
  const minutes = busy.reduce((n, p) => n + p.digest.minutes, 0)
  const subject = busy.length
    ? locale === 'en' ? `Today for you: about ${minutes === 1 ? '1 minute' : `${minutes} minutes`}` : `Heute für dich: ca. ${plural(minutes, 'Minute', 'Minuten')}`
    : locale === 'en' ? `News from ${live.length} workspaces` : `Neues aus ${live.length} Arbeitsbereichen`
  return { subject, body }
}

// Wann die Sammelmail rausgeht: vor 07:00 um 07:00, sonst im nächsten 5-Minuten-Takt (Bereiche zur selben Zeit landen in einer Mail).
export function morningMailAt(ws: Workspace, at: Date): Date {
  const d = today(ws.timezone)
  if (minutesOf(nowTime(ws.timezone)) < minutesOf(QUIET_UNTIL)) return zonedToUtc(d, QUIET_UNTIL, ws.timezone)
  return new Date(Math.ceil((at.getTime() + 60_000) / 300_000) * 300_000)
}

// Eine Nachricht am Morgen je Person, nur wenn es etwas gibt. Keine Einzelmeldungen je Aufgabe.
// Je Arbeitsbereich entsteht eine Benachrichtigung, die Mail bündelt der Job morning_mail je Person.
export async function sendMorningDigest(db: DbOrTx, ws: Workspace, at: Date = now()): Promise<number> {
  const time = nowTime(ws.timezone)
  if (minutesOf(time) >= minutesOf(QUIET_FROM)) return 0
  const d = today(ws.timezone)
  const mailAt = morningMailAt(ws, at)
  let n = 0
  for (const g of await morningDigests(db, ws)) {
    if (!digestHasContent(g)) continue
    const de = digestText(g, 'de')
    const en = digestText(g, 'en')
    const home = `${config.appUrl}/p/${ALL_SLUG}`
    const k = await notify(db, ws.id, g.userId, 'morning_digest', {
      minutes: g.minutes,
      count: g.items.length,
      workspace: ws.name,
      digest: g as unknown as Record<string, unknown>,
      text: { de: { ...de, actionUrl: home, actionLabel: 'Aimarage öffnen' }, en: { ...en, actionUrl: home, actionLabel: 'Open Aimarage' } },
    }, { dedupeKey: `morning:${ws.id}:${d}`, channels: [] })
    if (!k) continue
    n += k
    await enqueueJob(db, 'morning_mail', { payload: { userId: g.userId }, dedupeKey: `morning_mail:${g.userId}:${mailAt.toISOString()}`, runAt: mailAt, maxAttempts: 3 })
  }
  return n
}

// Verschickt alle noch nicht gemailten Morgen-Nachrichten einer Person (letzte 24 Stunden) als eine Mail.
export async function runMorningMail(db: DbOrTx, userId: string): Promise<number> {
  const [u] = await db.select({ email: schema.users.email, name: schema.users.name, locale: schema.users.locale, prefs: schema.users.prefs }).from(schema.users).where(eq(schema.users.id, userId))
  if (!u) return 0
  const rows = await db.select({ id: schema.notifications.id, payload: schema.notifications.payload }).from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.kind, 'morning_digest'), gt(schema.notifications.createdAt, new Date(now().getTime() - 86_400_000)), sql`${schema.notifications.payload} ? 'digest'`, sql`not (${schema.notifications.payload} ? 'mailedAt')`))
    .orderBy(asc(schema.notifications.createdAt))
  if (!rows.length) return 0
  const parts: DigestPart[] = rows.map(r => ({ workspace: String(r.payload.workspace ?? ''), digest: r.payload.digest as unknown as Digest }))
  const locale = u.locale === 'en' ? 'en' : 'de'
  const t = bundleDigestText(parts, locale)
  // Abbestellt (Profil oder Abmeldelink): Nachrichten bleiben im Dashboard, es geht keine Mail raus.
  const on = morningMailOn(u.prefs)
  if (t && on && u.email.includes('@')) {
    const home = `${config.appUrl}/p/${ALL_SLUG}`
    await queueSystemMail(db, u.email, 'generic-notice', { subject: t.subject, body: t.body, name: u.name, actionUrl: home, actionLabel: locale === 'en' ? 'Open Aimarage' : 'Aimarage öffnen', unsubscribeUrl: unsubscribeUrl(userId) }, locale, { dedupeKey: `notify:${rows[0]!.id}`, headers: unsubscribeHeaders(userId) })
  }
  await db.update(schema.notifications).set({ payload: sql`${schema.notifications.payload} || ${JSON.stringify({ mailedAt: now().toISOString() })}::jsonb` }).where(inArray(schema.notifications.id, rows.map(r => r.id)))
  return t && on ? 1 : 0
}
