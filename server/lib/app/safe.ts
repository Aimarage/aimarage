import { createError, H3Error } from 'h3'
import { limitReply, PAUSED_REPLY } from '../chat'
import { isLimitError } from '../limits'
import { TALK_DROPPED } from '../../../shared/utils/talk'

export type SafeLang = 'de' | 'en'

// App-Store-Regeln: in der iPhone-App keine Preise, Tarife, Kaufknöpfe oder Hinweise auf Kaufwege (auch nicht "im Web").
const PURCHASE = [
  /\/abo\b/i,
  /\/billing\b/i,
  /upgrade/i,
  /zusatz(konto|konten|projekt)/i,
  /\btarif/i,
  /(?<![-\w])abo\b/i,
  /\babonnement/i,
  /testphase/i,
  /zahlung und rechnungen/i,
  /\bmehr budget\b/i,
  /\bmore (ai |llm )?budget\b/i,
  /\b(budget|konto|konten|kontingent|limit|grenze|projekte?|speicher)\b[^.!?\n]{0,40}\b(kaufen|buchen|nachkaufen|aufstocken|dazubuchen|dazukaufen)\b/i,
  /\b(subscri(?:be|ption)s?|billing|pricing|price plan|your plan|view plan|paid plan|free trial)\b/i,
  /\b(paid|pro|starter|agency|business|higher|bigger|larger|free|premium)\s+(plan|tier)s?\b/i,
  /\b(plan|tier)\s+(limits?|upgrades?|prices?)\b/i,
  /\b(trial (period|phase|days?|ends?|ended|expires?|expired|account)|(your|the) trial)\b/i,
  /\b(extra|additional) (accounts?|projects?|seats?)\b/i,
  /\b(payments? and invoices|in-app purchases?)\b/i,
  /\b(buy|purchase)\b[^.!?\n]{0,30}\b(plan|credits?|budget|accounts?|seats?|storage|projects?)\b/i,
  /\b(budget|accounts?|credits?|limits?|projects?|seats?|storage|quota)\b[^.!?\n]{0,40}\b(buy|purchase|top(?:ping)? up|book more)\b/i,
  /\d[\d.,]*\s*(eur|euro|€|\$|usd)\s*(\/|pro|je|im|per|a|an?|each)\s*(monat|month|mo|jahr|year|yr)\b/i,
  /(€|eur|euro|\$|usd)\s*\d[\d.,]*\s*(\/|pro|je|im|per|a|an?|each)\s*(monat|month|mo|jahr|year|yr)\b/i,
  /(\d[\d.,]*\s*(eur|euro|€|\$|usd)|(€|eur|euro|\$|usd)\s*\d[\d.,]*)\s*(monatlich|jährlich|monthly|yearly|annually)/i,
  /\b(starter|pro|agentur|agency)\b[^.!?\n]{0,40}(\d[\d.,]*\s*(eur|euro|€|\$|usd)|(€|\$)\s*\d)/i,
]

export function mentionsPurchase(text: string): boolean {
  return PURCHASE.some(re => re.test(text))
}

const tx = (l: SafeLang, de: string, en: string) => (l === 'en' ? en : de)

export function neutralLimit(l: SafeLang): string {
  return tx(l, 'Limit des Arbeitsbereichs erreicht.', 'Workspace limit reached.')
}

// Bekannte Antworten des Agenten ohne Kaufhinweis.
function known(text: string, l: SafeLang): string | null {
  const t = text.trim()
  if (t === PAUSED_REPLY) return tx(l, 'Ich arbeite gerade nicht.', 'I am not working right now.')
  if (t === limitReply('llmEurMonth')) return tx(l, 'Das KI-Budget für diesen Monat ist aufgebraucht, deshalb kann ich gerade nicht antworten. Freigegebene Beiträge werden weiter veröffentlicht.', 'This month\'s AI budget is used up, so I cannot answer right now. Approved posts are still published.')
  if (t === limitReply('')) return neutralLimit(l)
  return null
}

// Sätze mit Preis- oder Kaufhinweis fallen weg; bleibt nichts übrig, kommt ein neutraler Satz.
export function appSafeText(text: string, l: SafeLang): string {
  if (!text || !mentionsPurchase(text)) return text
  const k = known(text, l)
  if (k) return k
  const kept = text
    .split('\n')
    .map(line => line.split(/(?<=[.!?])\s+/).filter(x => !mentionsPurchase(x)).join(' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return kept || tx(l, 'Ich kann gerade nicht daran arbeiten.', 'I cannot work on this right now.')
}

const LIMIT_TEXT: Record<string, [string, string]> = {
  projects: ['Höchstzahl an Projekten des Arbeitsbereichs erreicht.', 'Workspace project limit reached.'],
  members: ['Höchstzahl an Nutzern des Arbeitsbereichs erreicht.', 'Workspace user limit reached.'],
  accounts: ['Höchstzahl an Konten des Arbeitsbereichs erreicht.', 'Workspace account limit reached.'],
  socialAccounts: ['Höchstzahl an Social-Konten des Arbeitsbereichs erreicht.', 'Workspace social account limit reached.'],
  llmEurMonth: ['KI-Budget für diesen Monat aufgebraucht.', 'AI budget for this month used up.'],
  servicesEurMonth: ['Budget für Dienste für diesen Monat aufgebraucht.', 'Service budget for this month used up.'],
  braveCallsPerDay: ['Tagesgrenze der Websuche erreicht.', 'Daily web search limit reached.'],
  storageMb: ['Speicherplatz des Arbeitsbereichs aufgebraucht.', 'Workspace storage used up.'],
  onePerPlatform: ['Je Projekt ist nur ein Konto pro Plattform möglich.', 'Only one account per platform per project.'],
}

export function appLimitMessage(kind: string | null | undefined, l: SafeLang): string {
  const t = kind ? LIMIT_TEXT[kind] : null
  return t ? t[l === 'en' ? 1 : 0] : neutralLimit(l)
}

// Feste Texte des Servers (Fehler, Agent-Standardantworten) auf Englisch für die App.
const EN_TEXT: Record<string, string> = {
  'Projekt nicht gefunden': 'Project not found',
  'Arbeitsbereich nicht gefunden': 'Workspace not found',
  'Aufgabe nicht gefunden': 'Task not found',
  'Entwurf nicht gefunden': 'Draft not found',
  'Push-Token ungültig': 'Invalid push token',
  'Gespräch nicht verfügbar': 'Conversation not available',
  'Der Agent ist noch nicht eingerichtet.': 'The agent is not set up yet.',
  'Der Agent ist noch nicht eingerichtet. Bitte im Web unter Einstellungen den KI-Zugang eintragen.': 'The agent is not set up yet. Please add the AI access in the web app under Settings.',
  'Diese Aufgabe ist schon abgeschlossen.': 'This task is already finished.',
  'Mails bitte im Web prüfen und senden.': 'Please review and send mails in the web app.',
  'Keine Berechtigung': 'Not allowed',
  'Nicht angemeldet': 'Not signed in',
  'Zu viele Anfragen': 'Too many requests',
  'Inzwischen gibt es eine neuere Fassung': 'There is a newer version by now',
  'Schon gesendet': 'Already sent',
  'Schon erledigt': 'Already done',
  'Der Agent braucht erst eine Antwort von dir': 'The agent needs an answer from you first',
  'Darauf konnte ich gerade nicht antworten. Schick es bitte nochmal.': 'I could not answer that just now. Please send it again.',
  [TALK_DROPPED]: 'Understood, I will leave it. The task is dropped and nothing goes out. To bring it back, set the status to "planned".',
}

export function appText(text: string, l: SafeLang): string {
  if (l !== 'en' || !text) return text
  return EN_TEXT[text] ?? EN_TEXT[text.replace(/\.$/, '')] ?? (/^Entwurf ist \w+$/.test(text) ? 'This draft can no longer be changed.' : text)
}

// Fehler für App-Antworten: Limit-Fehler (402, code limit) bekommen einen neutralen Text, sonst fallen Kaufhinweise weg.
export function appSafeError(err: unknown, l: SafeLang = 'de'): unknown {
  const e = err as { statusCode?: number, statusMessage?: string, message?: string, data?: { code?: string, kind?: string } | null }
  const limit = isLimitError(err) || e?.statusCode === 402 || e?.data?.code === 'limit'
  if (limit) {
    const kind = e?.data?.kind === 'trial' ? null : isLimitError(err) ? err.kind : e?.data?.kind
    const msg = appLimitMessage(kind, l)
    return createError({ statusCode: 402, statusMessage: msg, message: msg, data: { code: 'limit' } })
  }
  if (err instanceof H3Error) {
    const text = `${err.statusMessage ?? ''} ${err.message ?? ''}`
    if (mentionsPurchase(text)) {
      const msg = tx(l, 'Das geht gerade nicht.', 'This is not possible right now.')
      return createError({ statusCode: err.statusCode, statusMessage: msg, message: msg })
    }
    const msg = err.statusMessage ? appText(err.statusMessage, l) : ''
    if (msg && msg !== err.statusMessage) return createError({ statusCode: err.statusCode, statusMessage: msg, message: msg, data: err.data })
  }
  return err
}
