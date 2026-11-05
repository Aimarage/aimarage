export type TalkKind = 'question' | 'ask' | 'answer' | 'revise' | 'fact' | 'saved' | 'message' | 'queued'

export interface TalkLine {
  who: 'agent' | 'user'
  kind: TalkKind
  text: string
}

export const TALK_PREFIX = {
  user: 'Zum Entwurf:',
  ask: 'Rückfrage:',
  answer: 'Antwort:',
  revise: 'Verstanden:',
  fact: 'Merken?:',
  saved: 'Gemerkt:',
  queued: 'Wartet:',
} as const

const PATTERNS: [RegExp, boolean, TalkKind][] = [
  [/^Info nötig:\s*/, true, 'question'],
  [/^Rückfrage:\s*/, true, 'ask'],
  [/^Antwort:\s*/, true, 'answer'],
  [/^Verstanden:\s*/, true, 'revise'],
  [/^Merken\?:\s*/, true, 'fact'],
  [/^Gemerkt:\s*/, true, 'saved'],
  [/^Zum Entwurf:\s*/, false, 'message'],
  [/^Wartet:\s*/, false, 'queued'],
  [/^Antwort auf die Rückfrage "[\s\S]*?":\s*/, false, 'message'],
  [/^Antwort an den Agent:\s*/, false, 'message'],
]

export function talkLine(text: string, byAgent: boolean): TalkLine | null {
  for (const [re, agent, kind] of PATTERNS) {
    if (agent !== byAgent) continue
    const m = re.exec(text)
    if (m) return { who: agent ? 'agent' : 'user', kind, text: text.slice(m[0].length).trim() }
  }
  return null
}

export function isTalkNote(n: { text: string, byAgent: boolean }): boolean {
  return talkLine(n.text, n.byAgent) !== null
}

export interface DraftCheck {
  id: string
  kind: 'info' | 'check'
  text: string
}

export function draftChecks(notes: { id: string, text: string, byAgent: boolean, createdAt: string | Date }[], draftCreatedAt: string | Date): DraftCheck[] {
  const since = new Date(draftCreatedAt).getTime() - 2000
  const out: DraftCheck[] = []
  for (const n of notes) {
    if (!n.byAgent || new Date(n.createdAt).getTime() < since) continue
    const m = n.text.match(/^(Info nötig|Nachprüfung):\s*(.*)$/s)
    if (m) out.push({ id: n.id, kind: m[1] === 'Info nötig' ? 'info' : 'check', text: m[2]! })
  }
  return out
}

// Rückfragen, auf die ein Mensch schon geantwortet hat ("Info nötig" des Agenten, danach eine Notiz des Menschen).
export function answeredQuestions(notes: { text: string, byAgent: boolean, createdAt: string | Date }[]): string[] {
  const sorted = [...notes].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  const out: string[] = []
  sorted.forEach((n, i) => {
    if (!n.byAgent || !n.text.startsWith('Info nötig:')) return
    if (sorted.slice(i + 1).some(m => !m.byAgent)) out.push(n.text.replace(/^Info nötig:\s*/, ''))
  })
  return out
}

const normQ = (s: string) => s.replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()

// Beantwortete Rückfragen kommen nicht wieder: gleiche Frage (auch als Teil einer früheren Sammel-Frage) fällt weg.
export function dropAnswered(missing: string[], notes: { text: string, byAgent: boolean, createdAt: string | Date }[]): string[] {
  const done = answeredQuestions(notes).map(normQ)
  if (!done.length) return missing
  return missing.filter(m => !done.some(d => d.includes(normQ(m))))
}

export const TALK_DROPPED = 'Verstanden, das lasse ich. Die Aufgabe ist verworfen, es geht nichts raus. Zurückholen: Status auf "geplant" setzen.'

const DROP_ANY = [
  /\bbringt (ihm|ihr|ihnen|der person|denen|niemandem|keinem|uns)( \S+){0,2} (nichts|nix)\b/i,
  /\bvergiss (das|es|den|die)\b/i,
  /\bwill ich (so )?(nicht|nie) (schicken|senden|posten|veröffentlichen|abschicken|antworten)/i,
  /\b(lass|lassen wir) (das|es) (sein|bleiben)\b/i,
  /\bweg damit\b|^(bitte )?(verwerfen|wegwerfen)\b|\b(aufgabe|antwort|das) (bitte )?verwerfen\b|\bhilft (ihm|ihr|ihnen|der person|niemandem) (nicht|nichts|kein)/i,
  /\b(forget it|forget about it|doesn'?t fit|won'?t help|don'?t (send|post) (it|this)|not helpful)\b/i,
]
const DROP_SHORT = /^(das |der |die |es |passt |so )*(passt|bringt'?s|hilft) (hier |da |so |gar |überhaupt |leider )*(nicht|nichts|nix)\b/i
const REVISE_HINT = /\b(kürzer|länger|ändere|änder|schreib|formulier|statt|besser|mach|ersetz|umschreib|ton|anders|lockerer|förmlicher|nimm|füg|ergänz|link|satz|wort)/i

// Mensch will die Aufgabe nicht ("passt nicht", "bringt ihm nichts", "vergiss das"): schließen statt neu schreiben.
export function wantsDrop(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 300) return false
  if (DROP_ANY.some(re => re.test(t))) return !(/\b(aber|sondern|stattdessen|außer)\b/i.test(t) && REVISE_HINT.test(t))
  return DROP_SHORT.test(t) && !REVISE_HINT.test(t)
}

const NOT_TODAY = [
  /\b(heute|today)\b[^?]*\b(nicht|nichts|kein|keinen|keine|schon|bereits|not|already)\b/i,
  /\b(nicht|kein\w*) (mehr )?heute\b/i,
  /\b(nicht mehr|lieber später|später|ein andermal|ein anderes mal|nächste woche|morgen|übermorgen|later|tomorrow|next week)\b/i,
  /\b(will|möchte|mag) ich (da |dort |heute )?(nicht|nichts|kein)/i,
]

// Mensch sagt "heute nicht", "später", "will ich nicht": der Termin darf so nicht stehen bleiben.
export function notToday(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 400 || /\?\s*$/.test(t)) return false
  return NOT_TODAY.some(re => re.test(t))
}
