import { addDays, campaignWeek, daysInMonth, eachDay, isLastWeekdayOfMonth, nthWeekdayOfMonth, type IsoDate, weekday } from './dates'

export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type WeekdayCode = typeof WEEKDAY_CODES[number]

export type Rule =
  | { kind: 'daily' }
  | { kind: 'weekdays' }
  | { kind: 'weekly', days: number[], interval: number }
  | { kind: 'monthly-nth', nth: number, day: number }
  | { kind: 'monthly-day', dom: number }
  | { kind: 'quarterly-nth', nth: number, day: number }

function dayNum(code: string): number {
  const i = WEEKDAY_CODES.indexOf(code.toUpperCase() as WeekdayCode)
  if (i < 0) throw new Error(`Unbekannter Wochentag: ${code}`)
  return i + 1
}

export function parseRule(raw: string): Rule {
  const rule = raw.trim()
  if (rule === 'daily') return { kind: 'daily' }
  if (rule === 'weekdays') return { kind: 'weekdays' }
  const [head, arg = ''] = rule.split(':')
  if (head === 'weekly' || head === 'biweekly') {
    const days = arg.split(',').filter(Boolean).map(dayNum)
    if (!days.length) throw new Error(`Regel ohne Wochentag: ${raw}`)
    return { kind: 'weekly', days: [...new Set(days)].sort(), interval: head === 'biweekly' ? 2 : 1 }
  }
  if (head === 'monthly' || head === 'quarterly') {
    const nthMatch = /^(-1|[1-4])([A-Z]{2})$/i.exec(arg)
    if (nthMatch) {
      const nth = Number(nthMatch[1])
      const day = dayNum(nthMatch[2]!)
      return head === 'monthly' ? { kind: 'monthly-nth', nth, day } : { kind: 'quarterly-nth', nth, day }
    }
    if (head === 'monthly' && /^(-1|[1-9]|[12]\d|3[01])$/.test(arg)) return { kind: 'monthly-day', dom: Number(arg) }
  }
  throw new Error(`Unbekannte Regel: ${raw}`)
}

export function isValidRule(raw: string): boolean {
  try {
    parseRule(raw)
    return true
  }
  catch {
    return false
  }
}

function matchesNth(d: IsoDate, nth: number, day: number): boolean {
  if (weekday(d) !== day) return false
  return nth === -1 ? isLastWeekdayOfMonth(d) : nthWeekdayOfMonth(d) === nth
}

export function matches(rule: Rule, d: IsoDate, anchor?: IsoDate): boolean {
  switch (rule.kind) {
    case 'daily': return true
    case 'weekdays': return weekday(d) <= 5
    case 'weekly': {
      if (!rule.days.includes(weekday(d))) return false
      if (rule.interval === 1 || !anchor) return true
      return (campaignWeek(anchor, d) - 1) % rule.interval === 0
    }
    case 'monthly-nth': return matchesNth(d, rule.nth, rule.day)
    case 'monthly-day': {
      const dom = Number(d.slice(8, 10))
      const dim = daysInMonth(d)
      return rule.dom === -1 ? dom === dim : dom === Math.min(rule.dom, dim)
    }
    case 'quarterly-nth': {
      const month = Number(d.slice(5, 7))
      return (month - 1) % 3 === 0 && matchesNth(d, rule.nth, rule.day)
    }
  }
}

export function occurrences(raw: string | Rule, from: IsoDate, to: IsoDate, anchor?: IsoDate): IsoDate[] {
  const rule = typeof raw === 'string' ? parseRule(raw) : raw
  if (to < from) return []
  return eachDay(from, to).filter(d => matches(rule, d, anchor))
}

export function nextOccurrence(raw: string, after: IsoDate, anchor?: IsoDate, horizonDays = 400): IsoDate | null {
  const rule = parseRule(raw)
  for (let i = 1; i <= horizonDays; i++) {
    const d = addDays(after, i)
    if (matches(rule, d, anchor)) return d
  }
  return null
}

export interface FocusPlanLike {
  fixed?: Record<string, string | null>
  rotation?: string[]
  rotationStartWeek?: number
}

export function focusFor(plan: FocusPlanLike, campaignStart: IsoDate, d: IsoDate): string | null {
  const week = campaignWeek(campaignStart, d)
  if (week < 1) return null
  const fixed = plan.fixed?.[String(week)]
  if (fixed !== undefined) return fixed
  const rotation = plan.rotation ?? []
  if (!rotation.length) return null
  const startWeek = plan.rotationStartWeek ?? 1
  if (week < startWeek) return null
  return rotation[(week - startWeek) % rotation.length] ?? null
}

export interface RecurrenceLike {
  rule: string
  projectMode: 'fixed' | 'focus' | 'nonfocus' | 'each'
  projectId: string | null
  focusOnly?: boolean
  startDate?: IsoDate | null
  untilDate?: IsoDate | null
}

export interface CampaignLike {
  startDate: IsoDate
  endDate?: IsoDate | null
  focusPlan: FocusPlanLike
}

export interface Occurrence {
  date: IsoDate
  projectId: string | null
  key: string
}

export function occurrenceKey(date: IsoDate, projectId: string | null): string {
  return `${date}|${projectId ?? 'alle'}`
}

export function expandRecurrence(rec: RecurrenceLike, campaign: CampaignLike | null, projectIds: string[], from: IsoDate, to: IsoDate): Occurrence[] {
  let start = from
  let end = to
  if (campaign) {
    if (campaign.startDate > start) start = campaign.startDate
    if (campaign.endDate && campaign.endDate < end) end = campaign.endDate
  }
  if (rec.startDate && rec.startDate > start) start = rec.startDate
  if (rec.untilDate && rec.untilDate < end) end = rec.untilDate
  const out: Occurrence[] = []
  for (const date of occurrences(rec.rule, start, end, campaign?.startDate ?? rec.startDate ?? undefined)) {
    const focus = campaign ? focusFor(campaign.focusPlan, campaign.startDate, date) : null
    let targets: (string | null)[]
    switch (rec.projectMode) {
      case 'fixed': targets = rec.focusOnly && focus !== rec.projectId ? [] : [rec.projectId]; break
      case 'focus': targets = [focus]; break
      case 'nonfocus': targets = focus ? projectIds.filter(p => p !== focus) : []; break
      case 'each': targets = projectIds; break
    }
    for (const projectId of targets) out.push({ date, projectId, key: occurrenceKey(date, projectId) })
  }
  return out
}

const DAY_NAMES_DE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']
const DAY_SHORT_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

export function describeRule(raw: string): string {
  let rule: Rule
  try {
    rule = parseRule(raw)
  }
  catch {
    return raw
  }
  const nthText = (nth: number) => (nth === -1 ? 'letzten' : `${nth}.`)
  switch (rule.kind) {
    case 'daily': return 'täglich'
    case 'weekdays': return 'Mo-Fr täglich'
    case 'weekly': return `${rule.interval === 2 ? 'alle 2 Wochen' : 'jeden'} ${rule.days.map(d => DAY_SHORT_DE[d - 1]).join(', ')}`
    case 'monthly-nth': return `jeden ${nthText(rule.nth)} ${DAY_NAMES_DE[rule.day - 1]} im Monat`
    case 'monthly-day': return rule.dom === -1 ? 'am Monatsletzten' : `am ${rule.dom}. jedes Monats`
    case 'quarterly-nth': return `jeden ${nthText(rule.nth)} ${DAY_NAMES_DE[rule.day - 1]} im Quartal`
  }
}
