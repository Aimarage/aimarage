// Allgemeine Community- und Karma-Aufgaben ("passende Threads suchen und antworten", "Karma aufbauen", "in Foren mitreden"):
// Die sucht nie der Mensch. Der Agent sucht selbst aktuelle Threads und legt 1-3 fertige Antworten als eigene Aufgaben in die Freigaben.

export const SWEEP_ORIGIN = 'sweep:'
export const SWEEP_MAX = 3
export const SWEEP_ASK = 'Rückfrage zu deinen Konten:'
export const SWEEP_NONE = 'Heute kein passender Thread:'
export const SWEEP_AGENT_STEP = 'Sucht täglich passende Threads und entwirft 1-3 Antworten'
export const SWEEP_PROBLEM = 'Problem der Person:'
export const SWEEP_HUMAN_STEP = 'Fertige Antwort kopieren und im Thread posten'

const SWEEP_TITLE = /karma|community[- ]antworten|passende[nr]?\s+threads|threads?\s+(such|find|sicht|beobacht)|mitreden|mitdiskutier|community[- ]?(präsenz|aufbau|pflege)|präsenz\s+(in|auf|aufbauen)|engagement\s+aufbauen|in\s+(foren|communities|subreddits)\s+(aktiv|antworten|helfen)|hilfreich\s+(antworten|kommentieren)/i
const SWEEP_STEP = /liste\s+passender\s+threads|passende[nr]?\s+threads|threads?\s+(suchen|finden|sichten|listen)|karma/i
const HUMAN_GENERIC = /^\s*(kommentieren|antworten|mitreden|mitdiskutieren|posten|selbst (kommentieren|antworten)|kommentieren und antworten|antworten,? wo es passt)\s*\.?\s*$/i
const THREAD_URL = /reddit\.com\/r\/[^/]+\/comments\/|news\.ycombinator\.com\/item|indiehackers\.com\/post\/|producthunt\.com\/(posts|discussions)\//i

export interface SweepTask {
  title: string
  category: string
  status?: string
  agentStep?: string | null
  humanStep?: string | null
  targetUrl?: string | null
  origin?: string | null
}

export function isSweepChild(t: Pick<SweepTask, 'origin'>): boolean {
  return !!t.origin?.startsWith(SWEEP_ORIGIN)
}

export function isCommunitySweep(t: SweepTask): boolean {
  if (t.category !== 'community' || isSweepChild(t) || t.origin?.startsWith('listening:')) return false
  if (t.targetUrl && THREAD_URL.test(t.targetUrl)) return false
  if (/^\s*(antwort|reply|re:)\b/i.test(t.title)) return false
  if (SWEEP_TITLE.test(t.title) || t.agentStep === SWEEP_AGENT_STEP) return true
  return SWEEP_STEP.test(t.agentStep ?? '') && (!t.humanStep || HUMAN_GENERIC.test(t.humanStep) || SWEEP_STEP.test(t.humanStep))
}

export interface SweepService {
  key: 'reddit' | 'hn' | 'indiehackers' | 'producthunt'
  name: string
  host: string | null
  match: RegExp
}

export const SWEEP_SERVICES: SweepService[] = [
  { key: 'reddit', name: 'Reddit', host: null, match: /reddit|(^|[\s/(])r\/\w+/i },
  { key: 'hn', name: 'Hacker News', host: 'news.ycombinator.com', match: /hacker[- ]?news|\bHN\b|ycombinator/i },
  { key: 'indiehackers', name: 'Indie Hackers', host: 'indiehackers.com', match: /indie[- ]?hackers/i },
  { key: 'producthunt', name: 'Product Hunt', host: 'producthunt.com', match: /product[- ]?hunt/i },
]

// Welche Dienste die Aufgabe nennt; ohne Nennung Reddit.
export function sweepServices(t: Pick<SweepTask, 'title' | 'agentStep' | 'humanStep'> & { channel?: string | null, description?: string | null }): SweepService[] {
  const text = [t.title, t.channel, t.agentStep, t.humanStep, t.description].filter(Boolean).join(' ')
  const found = SWEEP_SERVICES.filter(s => s.match.test(text))
  return found.length ? found : [SWEEP_SERVICES[0]!]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// "Kein Konto bei Hacker News" im Gedächtnis: Dienst wird nicht mehr gefragt und nicht durchsucht.
export function accountDeclined(name: string, texts: string[]): boolean {
  const re = new RegExp(`kein(e|en)?\\s+(konto|account)\\s+(bei|auf)\\s+${escapeRe(name)}`, 'i')
  return texts.some(x => re.test(x))
}

const NO = /\b(nein|no|nope|kein|keins|keine|keinen|nicht|never|nie|nirgends)\b/i
const ALL_YES = /^\s*(ja|jo|yes|yep|überall|alle|habe? (ich )?alle|bei allen)\b/i
const ALL_NO = /^\s*(nein|no|nope|keins|keine|nirgends|bei keinem)\b/i

// Antwort des Menschen auf die Konto-Rückfrage, ohne KI: je Dienst ja, nein oder unklar.
export function parseAccountAnswer(text: string, names: string[]): Record<string, 'yes' | 'no' | null> {
  const out: Record<string, 'yes' | 'no' | null> = {}
  const clauses = text.split(/[\n,;.]|\s+(?:und|aber|sowie|and|but)\s+/i).map(c => c.trim()).filter(Boolean)
  const named = (c: string) => SWEEP_SERVICES.some(s => s.match.test(c))
  const global = clauses.some(named) ? null : ALL_NO.test(text) ? 'no' : ALL_YES.test(text) ? 'yes' : null
  for (const name of names) {
    const svc = SWEEP_SERVICES.find(s => s.name === name)
    const c = clauses.find(x => (svc ? svc.match.test(x) : x.toLowerCase().includes(name.toLowerCase())))
    out[name] = c ? (NO.test(c) ? 'no' : 'yes') : global
  }
  return out
}

export function askAccountsText(names: string[]): string {
  const list = names.join(', ').replace(/, ([^,]+)$/, ' und $1')
  return `Hast du schon ein Konto bei ${list}? Antworte kurz, z.B. "${names[0]} ja, ${names[1] ?? names[0]} nein". Wo du eins hast, sucht der Agent dort auch Threads und schreibt dir Antworten; wo nicht, lässt er den Dienst weg.`
}

const REPLY_WORDS = /(^|[^\p{L}])(antwort|antworten|beantworten|reply|replies|kommentar|kommentare|kommentieren|comment|comments|thread|threads|mitreden|mitdiskutieren)([^\p{L}]|$)/iu

// Geplante Community-Antwort ohne echten Thread ("Antworten in r/x", "Threads kommentieren"): entsteht nur aus Suche oder Listening.
export function isBlindReply(t: { title: string, category: string }): boolean {
  if (t.category !== 'community') return false
  return REPLY_WORDS.test(t.title) || isCommunitySweep({ title: t.title, category: t.category })
}
