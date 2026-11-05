import { detectLang } from './outbound-guard'

// Ton für Kommentare und Antworten unter Beiträgen anderer: wie echte Leute, nicht wie eine KI oder ein Ratgeber.

export type ToneKind = 'search' | 'mention' | 'conversation'

export const TONE_RULES = [
  '- Schreib wie ein echter Mensch in Kommentaren: kurz, locker, persönlich, in der Sprache des Beitrags. Eher ein, zwei Sätze als ein Absatz.',
  '- Erlaubt: ehrliche Anerkennung (z.B. "hey, das find ich cool"), eine eigene kleine Erfahrung, eine echte Reaktion, eine interessante Info, die genau zum Beitrag passt.',
  '- Verboten: Tipps, Ratschläge, Belehrungen und Warnungen, nach denen keiner gefragt hat. Negativbeispiel, das wir selbst bekommen haben: unter einem Post über einen neuen MCP-Server "pass auf, dass niemand deinen Server hackt". So etwas nie.',
  '- Keine Floskeln ("Great point", "Love this", "Thanks for sharing", "Spannender Beitrag", "So true"), keine Aufzählungen, keine anbiedernden Rückfragen ("What do you think?", "Was meint ihr?"), keine Hashtags, höchstens ein Emoji, keine langen Striche.',
]

const CONVO_ONLY = [
  '- Keine Links, keine Produktnamen. "Ich entwickle X" bzw. "I build X" nur, wenn es wirklich zum Kommentar gehört; sonst gar nicht über das eigene Projekt reden. Es geht ums Mitreden, nicht um Werbung.',
]

export function toneRules(kind: ToneKind): string[] {
  return kind === 'conversation' ? [...TONE_RULES, ...CONVO_ONLY] : TONE_RULES
}

// Typische KI-Phrasen (de/en). Treffer: neu schreiben oder überspringen.
export const AI_PHRASES: RegExp[] = [
  /\bgreat (point|question|post|thread|insight|take|share)\b/i,
  /^(love|loving) (this|it|that)\b/i,
  /\bthanks? (you )?for sharing\b/i,
  /\bcouldn'?t agree more\b/i,
  /\b(spot on|well said|well put|so true|this is so true|totally agree)\b/i,
  /\bgame[- ]?changer\b/i,
  /\b(delve|delving|tapestry|testament to|resonates? (with|deeply)|food for thought|a must[- ]read)\b/i,
  /\bin today'?s (fast[- ]paced|digital|ever[- ]changing)\b/i,
  /\b(navigating|unlock(ing)?|elevate|harness(ing)?) the\b/i,
  /\bit'?s (worth|important to) (noting|note|remember|mention)\b/i,
  /\bkeep up the (great|good|amazing) work\b/i,
  /\b(curious|would love|i'?d love) to hear\b/i,
  /\bwhat do you (all )?think\??\s*$/i,
  /\bwhat are your thoughts\b/i,
  /\bexcited to see (what|how|where)\b/i,
  /\bas an ai\b/i,
  /\b(toller|guter|starker|spannender|interessanter|wichtiger) (punkt|beitrag|gedanke|hinweis|input)\b/i,
  /\bdanke (dir |euch )?(fürs|für's|für das) teilen\b/i,
  /\bda stimme ich (dir |ihnen |euch )?(voll und ganz|zu 100|absolut)\b/i,
  /\bgenau so ist es\b/i,
  /\bin der heutigen (zeit|welt)\b/i,
  /\b(eintauchen|tauchen wir ein)\b/i,
  /\bwas (meint|denkt|sagt) ihr( dazu)?\?\s*$/i,
  /\bbin (schon )?gespannt, (was|wie|wohin)\b/i,
  /\bwertvolle?r? (beitrag|input|tipps?|impuls)\b/i,
]

// Ungefragte Tipps, Ratschläge und Warnungen (de/en).
export const ADVICE_PHRASES: RegExp[] = [
  /\b(be careful|watch out|make sure (to|you|that)|don'?t forget to|pro tip|protip|you might want to|you should (also |really )?(consider|try|check|look|make|use|add)|have you (considered|thought about|tried)|i'?d (recommend|suggest)|keep in mind|remember to)\b/i,
  /\b(pass auf|passt auf|achte darauf|achtet darauf|vergiss nicht|vergesst nicht|denk(e)? (daran|dran)|du solltest|ihr solltet|mein tipp|kleiner tipp|tipp:|hast du (schon )?(mal )?(überlegt|daran gedacht|probiert)|ich würde (dir |euch )?(empfehlen|raten)|nicht vergessen)\b/i,
]

const LINK = /(https?:\/\/|www\.)\S+/i
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/u
const LIST = /^\s*([-*•]|\d+[.)])\s+/m
const EMOJI = /\p{Extended_Pictographic}/gu
const DISCLOSE = /\b(ich (entwickle|baue|mache|arbeite an)|wir (entwickeln|bauen|machen)|i('m| am) (building|making|working on)|i (build|make|made|built)|we (build|make|made|built)|developer behind|the band behind|hinter)\b/i

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface ToneOptions {
  kind: ToneKind
  projectName?: string | null
  others?: string[]
  maxLen?: number | null
}

// Was an einem Kommentar nach KI, Ratgeber oder Werbung klingt. Leere Liste = in Ordnung.
export function toneProblems(text: string, o: ToneOptions): string[] {
  const t = text.trim()
  const out: string[] = []
  if (!t) return ['leer']
  for (const re of AI_PHRASES) {
    const m = re.exec(t)
    if (m) out.push(`KI-Floskel "${m[0].trim()}"`)
  }
  if (o.kind !== 'search') {
    for (const re of ADVICE_PHRASES) {
      const m = re.exec(t)
      if (m) out.push(`ungefragter Rat "${m[0].trim()}"`)
    }
  }
  if (LIST.test(t)) out.push('Aufzählung')
  if ((t.match(EMOJI) ?? []).length > 1) out.push('mehrere Emojis')
  if (/[\u2013\u2014]/.test(t)) out.push('langer Strich')
  if (o.kind === 'conversation') {
    if (LINK.test(t)) out.push('Link')
    if (HASHTAG.test(t)) out.push('Hashtag')
    const name = o.projectName?.trim()
    if (name && name.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(name)}([^\\p{L}\\p{N}]|$)`, 'iu').test(t) && !DISCLOSE.test(t)) out.push(`Produktname "${name}"`)
    for (const c of o.others ?? []) {
      const n = c.trim()
      if (n.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}([^\\p{L}\\p{N}]|$)`, 'iu').test(t)) out.push(`Produktname "${n}"`)
    }
  }
  if (o.maxLen && t.length > o.maxLen) out.push(`zu lang (${t.length} statt höchstens ${o.maxLen} Zeichen)`)
  return [...new Set(out)]
}

export function medianLength(texts: string[]): number | null {
  const l = texts.map(s => s.trim().length).filter(n => n > 0).sort((a, b) => a - b)
  if (!l.length) return null
  const m = Math.floor(l.length / 2)
  return l.length % 2 ? l[m]! : Math.round((l[m - 1]! + l[m]!) / 2)
}

// Ziellänge: Median der echten Kommentare, sonst kurz; Obergrenze großzügig, aber nie über das Plattform-Limit.
export function targetLength(median: number | null, platformMax: number): { target: number, max: number } {
  const target = Math.max(40, Math.min(median ?? 110, platformMax))
  return { target, max: Math.min(platformMax, Math.max(90, Math.round(target * 2.2))) }
}

// Sprache des Beitrags: Metadaten (Mastodon language, Bluesky langs), widerspricht die Erkennung deutlich, gilt die Erkennung (Client-Voreinstellung oft falsch).
export function postLang(text: string, meta: string | null | undefined): string | null {
  const m = (meta ?? '').toLowerCase().slice(0, 2)
  const d = detectLang(text)
  if (d && d !== m) return d
  return /^[a-z]{2}$/.test(m) ? m : null
}

const LANG_NAMES: Record<string, string> = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', nl: 'Niederländisch', pt: 'Portugiesisch', pl: 'Polnisch', sv: 'Schwedisch', da: 'Dänisch', no: 'Norwegisch', fi: 'Finnisch', cs: 'Tschechisch', ja: 'Japanisch' }

export function langName(code: string): string {
  return LANG_NAMES[code.toLowerCase().slice(0, 2)] ?? code
}

// Pflicht beim Schreiben: Kommentar in der Sprache des Beitrags, nie in der Sprache der Anweisungen.
export function langRule(code: string): string {
  return `- Sprache: ${langName(code)} (${code}), wie der Beitrag. Alle Fassungen auf ${langName(code)}, auch wenn diese Anweisungen deutsch sind.`
}

// Falsche Sprache verwirft die Fassung (null bei unklarer Erkennung, z.B. sehr kurz).
export function wrongLang(text: string, code: string | null): string | null {
  if (!code) return null
  const got = detectLang(text)
  return got && got !== code.slice(0, 2) ? `falsche Sprache (${langName(got)} statt ${langName(code)})` : null
}
