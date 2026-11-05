export const MAIL_CATEGORIES = ['antwort', 'wichtig', 'info', 'newsletter', 'spam'] as const
export type MailCat = typeof MAIL_CATEGORIES[number]

export function isMailCat(v: unknown): v is MailCat {
  return typeof v === 'string' && (MAIL_CATEGORIES as readonly string[]).includes(v)
}

// Feste Hinweise aus den Regeln, als Schlüssel gespeichert und je Sprache übersetzt
export const NOTE_KEYS = ['@pwreset', '@login', '@payment', '@verify', '@welcome', '@code', '@submission'] as const
export type NoteKey = typeof NOTE_KEYS[number]

const NOTE_TEXT: Record<NoteKey, { de: string, en: string }> = {
  '@pwreset': { de: 'Passwort zurücksetzen angefordert', en: 'password reset requested' },
  '@login': { de: 'Login- oder Sicherheitswarnung', en: 'login or security alert' },
  '@payment': { de: 'Zahlung oder Rechnung', en: 'payment or invoice' },
  '@verify': { de: 'Konto oder Adresse bestätigen', en: 'confirm account or address' },
  '@welcome': { de: 'Konto angelegt', en: 'account created' },
  '@code': { de: 'Bestätigungscode', en: 'confirmation code' },
  '@submission': { de: 'Einreichung', en: 'submission' },
}

export function noteText(note: string | null | undefined, locale: 'de' | 'en'): string | null {
  if (!note) return null
  return (NOTE_TEXT as Record<string, { de: string, en: string }>)[note]?.[locale] ?? note
}

export interface MailFacts {
  from: string
  fromName: string | null
  subject: string
  text: string
  bulk: boolean
  list: boolean
}

const PLATFORMS: [RegExp, string][] = [
  [/(^|\.)(bsky\.app|bsky\.social|blueskyweb\.xyz)$/, 'Bluesky'],
  [/(^|\.)(joinmastodon\.org|mastodon\.[a-z.]+|mstdn\.[a-z.]+|mas\.to|fosstodon\.org)$/, 'Mastodon'],
  [/(^|\.)(x\.com|twitter\.com)$/, 'X'],
  [/(^|\.)(reddit\.com|redditmail\.com)$/, 'Reddit'],
  [/(^|\.)(facebookmail\.com|facebook\.com|meta\.com)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)threads\.(net|com)$/, 'Threads'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)dailyplaylists\.com$/, 'DailyPlaylists'],
  [/(^|\.)submithub\.com$/, 'SubmitHub'],
  [/(^|\.)groover\.co$/, 'Groover'],
  [/(^|\.)spotify\.com$/, 'Spotify'],
  [/(^|\.)soundcloud\.com$/, 'SoundCloud'],
  [/(^|\.)bandcamp\.com$/, 'Bandcamp'],
  [/(^|\.)distrokid\.com$/, 'DistroKid'],
  [/(^|\.)producthunt\.com$/, 'Product Hunt'],
  [/(^|\.)indiehackers\.com$/, 'Indie Hackers'],
  [/(^|\.)github\.com$/, 'GitHub'],
  [/(^|\.)discord\.com$/, 'Discord'],
  [/(^|\.)pinterest\.com$/, 'Pinterest'],
  [/(^|\.)medium\.com$/, 'Medium'],
  [/(^|\.)telegram\.org$/, 'Telegram'],
]

export function mailDomain(addr: string): string {
  return (addr.split('@')[1] ?? '').toLowerCase()
}

export function mailPlatform(addr: string): string | null {
  const d = mailDomain(addr)
  if (!d) return null
  return PLATFORMS.find(([re]) => re.test(d))?.[1] ?? null
}

const PWRESET = /password reset|reset (your |the )?password|forgot (your )?password|passwort (zurücksetzen|vergessen|ändern|zurückgesetzt)|kennwort (zurücksetzen|vergessen)|neues passwort|new password/i
const LOGIN = /new (sign[- ]?in|log[- ]?in)|sign[- ]?in (attempt|alert|from)|log[- ]?in (attempt|alert|from)|security alert|sicherheitswarnung|sicherheitshinweis|neue anmeldung|unusual (activity|sign)|ungewöhnliche aktivität|suspicious|verdächtig|two[- ]factor|zwei-faktor|2fa\b/i
const PAYMENT = /invoice|rechnung|receipt|quittung|zahlungseingang|zahlung|payment|payout|auszahlung|abbuchung|you were charged|refund|erstattung|bestellbestätigung|order confirmation/i
const VERIFY = /verify|verifiz|confirm (your |the )?(e-?mail|account|address|registration|sign ?up)|bestätige (deine|ihre|die)|bestätigung (deiner|ihrer) (e-?mail|adresse|registrierung)|activate (your )?account|konto aktivieren|aktiviere dein/i
const WELCOME = /welcome to|welcome aboard|willkommen (bei|auf|an bord|im|in)|thanks for (signing up|joining|registering)|danke für (deine|ihre) registrierung|account (created|is ready|has been created)|konto (erstellt|eröffnet|angelegt|ist bereit)/i
const SUBMISSION = /your submissions?|submission (received|confirmed|accepted|approved|declined|rejected|update)|deine einreichung|einreichung (erhalten|bestätigt|angenommen|abgelehnt)/i
const NOTIFY = /favou?rited|boosted|mentioned you|followed you|new followers?|replied to (you|your)|liked your|reposted|hat dich erwähnt|folgt dir|neue[rn]? follower|hat deinen beitrag|gefällt dein|new (message|comment|reply) (from|on)|neue (nachricht|antwort|kommentar)/i

// Einordnung nur aus Kopfzeilen und Betreff, ohne KI. null: KI entscheidet.
export function ruleCategory(m: MailFacts, extracted: { code: string | null, link: string | null }): { category: MailCat, note: NoteKey | null } | null {
  const s = m.subject
  if (PWRESET.test(s)) return { category: 'wichtig', note: '@pwreset' }
  if (LOGIN.test(s)) return { category: 'wichtig', note: '@login' }
  if (!m.list && PAYMENT.test(s)) return { category: 'wichtig', note: '@payment' }
  if (VERIFY.test(s)) return { category: 'wichtig', note: '@verify' }
  if (WELCOME.test(s) && (!m.list || mailPlatform(m.from))) return { category: 'wichtig', note: '@welcome' }
  if (!m.list && extracted.code) return { category: 'wichtig', note: '@code' }
  if (mailPlatform(m.from) || NOTIFY.test(s)) return { category: 'info', note: SUBMISSION.test(s) ? '@submission' : null }
  if (m.bulk) return { category: 'newsletter', note: null }
  return null
}

function cleanName(s: string): string {
  return s.replace(/\b(team|support|notifications?|no-?reply|info|mail|news|newsletter)\b/gi, '').replace(/[|·:-]+\s*$/g, '').replace(/\s+/g, ' ').trim()
}

// Dienst, bei dem das Projekt laut Mail schon ein Konto hat (Willkommen, Bestätigung, Passwort-Reset, Einreichung)
export function accountService(m: MailFacts): string | null {
  const s = m.subject
  const platform = mailPlatform(m.from)
  const signal = WELCOME.test(s) || PWRESET.test(s) || VERIFY.test(s) || SUBMISSION.test(s) || (!!platform && NOTIFY.test(s))
  if (!signal) return null
  if (m.list && !platform) return null
  if (platform) return platform
  const named = /(?:welcome to|willkommen (?:bei|auf|im|in))\s+([\p{L}\d][\p{L}\d .&'-]{1,40}?)\s*(?:[!.,:|]|$)/iu.exec(s)?.[1]
  if (named) return named.trim()
  const fromName = m.fromName ? cleanName(m.fromName) : ''
  if (fromName && fromName.length <= 40) return fromName
  const d = mailDomain(m.from).split('.').slice(-2, -1)[0]
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : null
}

export interface InboxCounts {
  total: number
  antwort: number
  wichtig: number
  info: number
  newsletter: number
  spam: number
}

// Mail, die in der Tagesmail eine eigene Zeile bekommt: offene Antwort, wichtig oder eine bedeutsame Benachrichtigung (Konto, Sicherheit)
export interface NotableMail {
  id: string
  kind: 'antwort' | 'wichtig' | 'info'
  from: string
  note: string | null
  subject: string | null
  // Offene Antwort-Aufgabe zur Mail (steht dann schon als Aufgabe in der Tagesmail)
  taskId?: string
}

export interface InboxLine {
  projectId: string
  slug: string
  name: string
  counts: InboxCounts
  important: { id: string, from: string, note: string | null, subject: string | null }[]
  notable?: NotableMail[]
}

// Bearbeitungsstand einer Mail, die eine Antwort braucht: offen, beantwortet oder von Hand erledigt
export type MailDone = 'offen' | 'beantwortet' | 'erledigt'

const ACCOUNT_CHANGE = /(dein|ihr|your)e?s? (konto|account|profil|profile)\b.*\b(geändert|aktualisiert|umgestellt|gemacht|verknüpft|gesperrt|deaktiviert|eingeschränkt|gelöscht|changed|updated|moved|linked|suspended|disabled|restricted|deleted|locked)|(konto|account)[- ](änderung|change|update|suspended|locked|restricted)|meta-konto|meta account|accounts center|kontenübersicht|(e-?mail|adresse|address|telefonnummer|phone number) (wurde |was )?(geändert|changed)|zugriff (entzogen|gewährt)|access (removed|granted|revoked)|richtlinien|policy violation|verstoß|copyright|urheberrecht|takedown|monetari/i

// Benachrichtigung, die man kennen sollte, obwohl nichts zu antworten ist (Konto geändert, Sperre, Rechte)
export function notableInfo(subject: string | null | undefined): boolean {
  return !!subject && ACCOUNT_CHANGE.test(subject)
}

export function notableText(m: NotableMail, locale: 'de' | 'en'): string {
  const de = locale === 'de'
  const what = (noteText(m.note, locale) ?? m.subject ?? '').trim()
  const todo = m.kind === 'antwort' ? (de ? 'antworten oder als erledigt markieren' : 'reply or mark as done') : m.kind === 'wichtig' ? (de ? 'ansehen' : 'have a look') : (de ? 'nur zur Info' : 'for your information')
  return `- ${m.from}${what ? `: ${what}` : ''} (${todo})`
}

export function emptyCounts(): InboxCounts {
  return { total: 0, antwort: 0, wichtig: 0, info: 0, newsletter: 0, spam: 0 }
}

// "Postfach Visitors: 12 neu - 1 braucht Antwort, 2 wichtig, 9 Newsletter/Werbung" (für die Morgen-Mail)
export function inboxLineText(l: InboxLine, locale: 'de' | 'en'): string {
  const c = l.counts
  const ads = c.newsletter + c.spam
  const de = locale === 'de'
  const parts = [
    c.antwort ? (de ? `${c.antwort} ${c.antwort === 1 ? 'braucht' : 'brauchen'} Antwort` : `${c.antwort} ${c.antwort === 1 ? 'needs a reply' : 'need a reply'}`) : '',
    c.wichtig ? (de ? `${c.wichtig} wichtig` : `${c.wichtig} important`) : '',
    c.info ? (de ? `${c.info} ${c.info === 1 ? 'Benachrichtigung' : 'Benachrichtigungen'}` : `${c.info} ${c.info === 1 ? 'notification' : 'notifications'}`) : '',
    ads ? (de ? `${ads} Newsletter/Werbung` : `${ads} newsletters/ads`) : '',
  ].filter(Boolean)
  return de ? `Postfach ${l.name}: ${c.total} neu - ${parts.join(', ')}` : `Mailbox ${l.name}: ${c.total} new - ${parts.join(', ')}`
}

export function importantText(i: InboxLine['important'][number], locale: 'de' | 'en'): string {
  const what = noteText(i.note, locale) ?? i.subject ?? ''
  return `${locale === 'de' ? 'Wichtig im Postfach' : 'Important in the mailbox'}: ${i.from}${what ? ` - ${what}` : ''}`
}
