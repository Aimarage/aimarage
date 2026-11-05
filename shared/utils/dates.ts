export type IsoDate = string

const DAY_MS = 86_400_000

export function parseIso(d: IsoDate): Date {
  return new Date(`${d}T00:00:00Z`)
}

export function toIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10)
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return toIso(new Date(parseIso(d).getTime() + n * DAY_MS))
}

export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((parseIso(a).getTime() - parseIso(b).getTime()) / DAY_MS)
}

// Tage bis zu einem Termin: morgen = 1, heute = 0, überfällig < 0.
export function daysUntil(today: IsoDate, day: IsoDate): number {
  return diffDays(day, today)
}

export function weekday(d: IsoDate): number {
  const w = parseIso(d).getUTCDay()
  return w === 0 ? 7 : w
}

export function startOfWeek(d: IsoDate): IsoDate {
  return addDays(d, 1 - weekday(d))
}

export function startOfMonth(d: IsoDate): IsoDate {
  return `${d.slice(0, 7)}-01`
}

export function daysInMonth(d: IsoDate): number {
  const dt = parseIso(startOfMonth(d))
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate()
}

export function addMonths(d: IsoDate, n: number): IsoDate {
  const dt = parseIso(d)
  const target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, 1))
  const dim = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(dt.getUTCDate(), dim))
  return toIso(target)
}

export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

export function nthWeekdayOfMonth(d: IsoDate): number {
  return Math.floor((Number(d.slice(8, 10)) - 1) / 7) + 1
}

export function isLastWeekdayOfMonth(d: IsoDate): boolean {
  return addDays(d, 7).slice(0, 7) !== d.slice(0, 7)
}

export function todayIn(timezone: string, now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function timeIn(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('de-AT', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
}

export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export function timeOf(minutes: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t)
}

export function isValidIso(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && toIso(parseIso(d)) === d
}

export function campaignWeek(start: IsoDate, d: IsoDate): number {
  return Math.floor(diffDays(startOfWeek(d), startOfWeek(start)) / 7) + 1
}
