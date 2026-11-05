import { describe, expect, it } from 'vitest'
import { addDays, campaignWeek, startOfWeek, weekday } from '../../shared/utils/dates'
import { describeRule, expandRecurrence, focusFor, isValidRule, nextOccurrence, occurrences, parseRule } from '../../shared/utils/recurrence'

describe('Datumshilfen', () => {
  it('Wochentag und Wochenstart', () => {
    expect(weekday('2026-10-12')).toBe(1)
    expect(weekday('2026-10-18')).toBe(7)
    expect(startOfWeek('2026-10-15')).toBe('2026-10-12')
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(campaignWeek('2026-10-12', '2026-10-26')).toBe(3)
  })
})

describe('Regeln', () => {
  it('parst gültige Regeln', () => {
    expect(parseRule('weekly:MO,TH')).toEqual({ kind: 'weekly', days: [1, 4], interval: 1 })
    expect(parseRule('monthly:-1FR')).toEqual({ kind: 'monthly-nth', nth: -1, day: 5 })
    expect(isValidRule('monthly:15')).toBe(true)
    expect(isValidRule('weekly:XX')).toBe(false)
    expect(isValidRule('quatsch')).toBe(false)
  })

  it('Mo-Fr täglich ohne Wochenende', () => {
    const d = occurrences('weekdays', '2026-10-12', '2026-10-18')
    expect(d).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'])
  })

  it('erster Montag und letzter Freitag im Monat', () => {
    expect(occurrences('monthly:1MO', '2026-10-01', '2026-12-31')).toEqual(['2026-10-05', '2026-11-02', '2026-12-07'])
    expect(occurrences('monthly:-1FR', '2026-10-01', '2026-12-31')).toEqual(['2026-10-30', '2026-11-27', '2026-12-25'])
  })

  it('Monatstag wird am Monatsende begrenzt', () => {
    expect(occurrences('monthly:31', '2027-02-01', '2027-02-28')).toEqual(['2027-02-28'])
    expect(occurrences('monthly:-1', '2027-02-01', '2027-03-31')).toEqual(['2027-02-28', '2027-03-31'])
  })

  it('alle 2 Wochen ab Kampagnenstart', () => {
    expect(occurrences('biweekly:TU', '2026-10-12', '2026-11-08', '2026-10-12')).toEqual(['2026-10-13', '2026-10-27'])
  })

  it('quartalsweise', () => {
    expect(occurrences('quarterly:1MO', '2026-10-01', '2027-04-30')).toEqual(['2026-10-05', '2027-01-04', '2027-04-05'])
  })

  it('nächster Termin und Beschreibung', () => {
    expect(nextOccurrence('weekly:FR', '2026-10-16')).toBe('2026-10-23')
    expect(describeRule('weekly:MO')).toBe('jeden Mo')
    expect(describeRule('monthly:-1FR')).toBe('jeden letzten Freitag im Monat')
  })
})

describe('Fokus-Rotation', () => {
  const plan = { fixed: { 1: null, 2: null, 12: null }, rotation: ['amw', 'bmx', 'bit'], rotationStartWeek: 3 }
  it('Woche 1-2 alle, dann AMW, BMX, BIT', () => {
    expect(focusFor(plan, '2026-10-12', '2026-10-14')).toBeNull()
    expect(focusFor(plan, '2026-10-12', '2026-10-27')).toBe('amw')
    expect(focusFor(plan, '2026-10-12', '2026-11-03')).toBe('bmx')
    expect(focusFor(plan, '2026-10-12', '2026-11-10')).toBe('bit')
    expect(focusFor(plan, '2026-10-12', '2026-11-17')).toBe('amw')
    expect(focusFor(plan, '2026-10-12', '2026-12-29')).toBeNull()
    expect(focusFor(plan, '2026-10-12', '2027-01-05')).toBe('bmx')
  })

  const camp = { startDate: '2026-10-12', focusPlan: plan }
  const projects = ['amw', 'bmx', 'bit']
  it('focus-Modus nimmt das Fokusprojekt, in ALLE-Wochen übergreifend', () => {
    const occ = expandRecurrence({ rule: 'weekly:TU', projectMode: 'focus', projectId: null }, camp, projects, '2026-10-12', '2026-11-08')
    expect(occ.map(o => o.projectId)).toEqual([null, null, 'amw', 'bmx'])
  })
  it('nonfocus erzeugt je Nicht-Fokus-Projekt einen Termin', () => {
    const occ = expandRecurrence({ rule: 'weekly:TH', projectMode: 'nonfocus', projectId: null }, camp, projects, '2026-10-26', '2026-11-01')
    expect(occ.map(o => o.projectId)).toEqual(['bmx', 'bit'])
  })
  it('focusOnly nur in der eigenen Fokuswoche', () => {
    const occ = expandRecurrence({ rule: 'weekly:WE', projectMode: 'fixed', projectId: 'bmx', focusOnly: true }, camp, projects, '2026-10-12', '2026-11-30')
    expect(occ.map(o => o.date)).toEqual(['2026-11-04', '2026-11-25'])
  })
  it('nichts vor Kampagnenstart, Schlüssel eindeutig', () => {
    const occ = expandRecurrence({ rule: 'daily', projectMode: 'each', projectId: null }, camp, projects, '2026-10-01', '2026-10-12')
    expect(occ).toHaveLength(3)
    expect(new Set(occ.map(o => o.key)).size).toBe(3)
  })
})

describe('iCal', async () => {
  const { buildIcal } = await import('../../server/lib/ical')
  it('ganztags und mit Uhrzeit, mit Escaping', () => {
    const ics = buildIcal('Test', 'Europe/Vienna', [
      { id: 'a', code: 'X-1', title: 'Post; mit, Komma', dueDate: '2026-10-13', dueTime: '09:00', durationMin: 30, status: 'geplant', project: 'tonebase', url: 'http://x/a' },
      { id: 'b', code: 'X-2', title: 'Ganztags', dueDate: '2026-10-14', dueTime: null, durationMin: 30, status: 'erledigt', project: null, url: 'http://x/b' },
    ], new Date('2026-10-06T10:00:00Z'))
    expect(ics).toContain('DTSTART;TZID=Europe/Vienna:20261013T090000')
    expect(ics).toContain('DTEND;TZID=Europe/Vienna:20261013T093000')
    expect(ics).toContain('SUMMARY:tonebase: Post\\; mit\\, Komma')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261014')
    expect(ics).toContain('DTEND;VALUE=DATE:20261015')
    expect(ics).toContain('SUMMARY:[x] Ganztags')
    expect(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75)).toBe(true)
  })
})
