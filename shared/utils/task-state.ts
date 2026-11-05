import { addDays, minutesOf, weekday } from './dates'
import { DONE_STATUSES, OPEN_STATUSES, type TaskStatus } from './domain'
import { approveMinutes, SELF_DEFAULT_MIN, SELF_POST_MIN } from './time-budget'

// Eine Quelle der Wahrheit je Aufgabe: wer ist dran, was passiert als Nächstes, wann, überfällig, ab wann sichtbar.
// Dashboard, Freigaben, Menü-Zähler, Kalender, Aufgabenliste, Morgen-Mail und MCP lesen nur taskView().

export type TaskRoute = 'auto' | 'approve' | 'self'

// Drei Zustände für Symbole: du bist dran, die KI (oder Claude) macht es, erledigt.
export type TaskState = 'you' | 'ai' | 'done'
export const TASK_STATES: TaskState[] = ['you', 'ai', 'done']

export type Who = 'you' | 'ai' | 'claude' | 'waiting' | 'done' | 'dropped'
export type Next =
  | 'answer'
  | 'approve'
  | 'review'
  | 'post'
  | 'do'
  | 'aiWrites'
  | 'aiPublishes'
  | 'aiScheduled'
  | 'claudeChecks'
  | 'claude'
  | 'waiting'
  | 'done'
  | 'dropped'
// yours: "Du bist dran", soon: kommt für dich (noch nicht fällig), outgoing: "Geht raus" (die KI veröffentlicht selbst).
export type Bucket = 'yours' | 'soon' | 'outgoing' | 'ai' | 'claude' | 'waiting' | 'done'

export interface TaskFacts {
  status: TaskStatus
  dueDate: string | null
  dueTime: string | null
  durationMin?: number | null
  category: string
  draftKind?: string | null
  estimateMin?: number | null
  owner: 'agent' | 'human' | 'none'
  // Wer als Mensch zuständig ist (Zuständige Person, sonst Inhaber des Arbeitsbereichs).
  userId?: string | null
  forClaude?: boolean
  // Neuester Entwurf: offen (wartet auf Freigabe) oder freigegeben.
  draft?: 'open' | 'approved' | null
  info?: boolean
  busy?: boolean
  route: TaskRoute
  // Die KI veröffentlicht selbst: verbundenes Konto, Blog-API, Postfach oder Antwort-Konto.
  goesOut: boolean
  // Geplanter Versand (Social-Post, Mail, Artikel, Antwort), ISO.
  scheduledAt?: string | null
  running?: boolean
  // Claude bzw. der KI-Prüfer gibt diese Art frei.
  claudeChecks?: boolean
  // Menschenarbeit auch am Wochenende (Projekt-Regel), Standard nein.
  humanWeekend?: boolean
  // Allgemeine Community-Aufgabe: der Agent sucht Threads, die Antworten kommen als eigene Aufgaben.
  sweep?: boolean
}

export interface Clock {
  today: string
  time: string
}

export interface TaskView {
  who: Who
  next: Next
  bucket: Bucket
  state: TaskState
  // Maßgebliches Datum: Fälligkeit bzw. Versand.
  date: string | null
  time: string | null
  at: string | null
  overdue: boolean
  // Ab wann es unter "Du bist dran" steht.
  visibleFrom: string | null
  // Heute für dich dran (sichtbar und noch offen).
  now: boolean
  // Minuten für den Menschen, wenn er dran ist.
  min: number
  // Minuten, die später noch auf den Menschen zukommen (für die Planung).
  plannedMin: number
  userId: string | null
  // Steht unter Freigaben (Entwurf da).
  draft: boolean
  // Danach ist der Mensch dran: Claude bzw. der KI-Prüfer prüft, posten muss der Mensch selbst.
  then: 'post' | null
}

// Heute Arbeit für den Menschen: er ist dran oder postet nach Claudes Prüfung selbst.
export function forYouNow(v: Pick<TaskView, 'who' | 'now' | 'then'>): boolean {
  return (v.who === 'you' || v.then === 'post') && v.now
}

// Offene Entwürfe, die noch nicht heute dran sind: so viele Freigaben warten, davon Rückfragen, ab wann die nächste dran ist.
export interface Waiting { approvals: number, info: number, next: string | null }
export function waitingLater(views: TaskView[]): Waiting | null {
  const list = views.filter(v => v.draft && !forYouNow(v) && (v.next === 'answer' || v.next === 'approve' || v.next === 'review' || v.next === 'claudeChecks'))
  if (!list.length) return null
  const days = list.map(v => v.visibleFrom ?? v.date).filter((x): x is string => !!x).sort()
  return { approvals: list.length, info: list.filter(v => v.next === 'answer').length, next: days[0] ?? null }
}

// Minuten, die die Aufgabe den Menschen kostet (auch nach Claudes Prüfung).
export function humanMinutes(v: Pick<TaskView, 'who' | 'min' | 'then'>): number {
  return v.who === 'you' || v.then === 'post' ? v.min : 0
}

const isWeekendDay = (d: string) => weekday(d) >= 6

// Menschenarbeit nie am Wochenende: Sa/So rücken auf den Freitag davor.
export function humanDay(d: string, weekend = false): string {
  if (weekend) return d
  let x = d
  while (isWeekendDay(x)) x = addDays(x, -1)
  return x
}

export function isLate(date: string | null, time: string | null, durationMin: number | null | undefined, c: Clock): boolean {
  if (!date) return false
  if (date < c.today) return true
  if (date > c.today || !time) return false
  return minutesOf(time) + (durationMin ?? 0) <= minutesOf(c.time)
}

function selfMin(f: TaskFacts): number {
  if (f.draftKind === 'post') return SELF_POST_MIN.post
  if (f.draftKind === 'mail') return SELF_POST_MIN.mail
  if (f.category === 'verzeichnis') return SELF_POST_MIN.directory
  return Math.min(f.estimateMin ?? 10, 15)
}

export function taskView(f: TaskFacts, c: Clock): TaskView {
  const date = f.dueDate
  const time = f.dueTime
  const base = { date, time, at: null, overdue: false, visibleFrom: null, now: false, min: 0, plannedMin: 0, userId: f.userId ?? null, draft: !!f.draft, then: null }
  const ai = (next: Next, bucket: Bucket = 'ai', extra: Partial<TaskView> = {}): TaskView => ({ ...base, who: 'ai', next, bucket, state: 'ai', ...extra })

  if (f.status === 'verworfen') return { ...base, who: 'dropped', next: 'dropped', bucket: 'done', state: 'done', draft: false }
  if (DONE_STATUSES.includes(f.status)) return { ...base, who: 'done', next: 'done', bucket: 'done', state: 'done' }
  if (f.status === 'wartet') return { ...base, who: 'waiting', next: 'waiting', bucket: 'waiting', state: 'done' }
  if (f.forClaude) return { ...base, who: 'claude', next: 'claude', bucket: 'claude', state: 'ai' }
  if (f.running || f.scheduledAt) return ai('aiScheduled', 'outgoing', { at: f.scheduledAt ?? null })

  const you = (next: Next, min: number, visibleFrom: string | null): TaskView => {
    const from = visibleFrom ? humanDay(visibleFrom, f.humanWeekend) : null
    const now = from ? from <= c.today : next === 'approve' || next === 'review' || next === 'answer'
    return { ...base, who: 'you', next, bucket: now ? 'yours' : 'soon', state: 'you', overdue: isLate(date, time, f.durationMin, c), visibleFrom: from, now, min, plannedMin: min }
  }
  const approveMin = approveMinutes(f.draftKind, f.category)
  // Claude prüft bis zum Fälligkeitstag. Ist der Entwurf dann noch nicht freigegeben, gibt der Mensch frei (nie "nichts zu tun").
  // Postet die KI danach nicht selbst, steht er am Fälligkeitstag als "selbst posten, Claude prüft vorher" da, nach dem Termin als Prüfen für dich.
  const checks = (): TaskView => {
    const from = date ? humanDay(date, f.humanWeekend) : null
    const due = from ? from <= c.today : true
    const late = isLate(date, time, f.durationMin, c)
    const v: TaskView = { ...ai('claudeChecks', 'claude'), who: 'claude', plannedMin: 0, visibleFrom: from }
    if (f.goesOut) return due ? you('approve', approveMin, date) : v
    if (late) return you('review', approveMin, date)
    const m = selfMin(f)
    return { ...v, then: 'post', now: due, overdue: false, min: m, plannedMin: m }
  }

  if (f.draft === 'open') {
    if (f.info) return you('answer', 0, date)
    if (f.claudeChecks) return checks()
    return you(f.goesOut ? 'approve' : 'review', approveMin, date)
  }
  if (f.busy) return ai('aiWrites', 'ai', { plannedMin: f.sweep ? 0 : f.route === 'auto' ? 0 : f.route === 'approve' ? approveMin : selfMin(f) })
  if (f.status === 'freigegeben' || f.draft === 'approved') {
    if (f.goesOut) return ai('aiPublishes', 'outgoing')
    return you('post', selfMin(f), date)
  }
  if (f.status === 'entwurf_fertig') return you('post', selfMin(f), date)
  if (f.owner === 'agent') {
    if (f.sweep) return ai('aiWrites')
    if (f.route === 'auto') return ai('aiPublishes')
    return ai('aiWrites', 'ai', { plannedMin: f.route === 'approve' ? approveMin : selfMin(f) })
  }
  return you('do', f.estimateMin ?? SELF_DEFAULT_MIN, date)
}

// Kompatibel: überfällig nur für offene Aufgaben nach dem Termin.
export function isOverdue(t: { status: TaskStatus, dueDate: string | null, dueTime: string | null, durationMin?: number | null }, today: string, nowTime: string): boolean {
  if (!OPEN_STATUSES.includes(t.status)) return false
  return isLate(t.dueDate, t.dueTime, t.durationMin, { today, time: nowTime })
}

// Minuten einer Liste (alle Rückfragen zusammen einmal).
export function viewMinutes(views: TaskView[], infoBundle = 5): number {
  return views.reduce((s, v) => s + humanMinutes(v), 0) + (views.some(v => v.next === 'answer') ? infoBundle : 0)
}

// Erledigt für Zähler (Strategie, Berichte): erledigt, ausgewertet oder veröffentlicht und wartet auf Ergebnis.
export function countsAsDone(status: TaskStatus): boolean {
  return DONE_STATUSES.includes(status) || status === 'wartet'
}
