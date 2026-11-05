import type { Category, DraftKind } from './domain'
import { addDays, parseIso } from './dates'
import { WEEKDAY_CODES } from './recurrence'

export const WEIGHT_PER_WEEK: Record<number, number> = { 1: 0.25, 2: 0.5, 3: 1, 4: 2, 5: 3, 6: 5 }
export const MAX_WEIGHT = 6

export const STRATEGY_CATEGORIES = ['community', 'social', 'content', 'verzeichnis', 'outreach', 'launch'] as const
export type StrategyCategory = typeof STRATEGY_CATEGORIES[number]

export const DEFAULT_DAYS: Record<string, string[]> = {
  community: ['TU', 'TH', 'MO'],
  social: ['TH', 'TU', 'FR'],
  content: ['MO', 'WE', 'FR'],
  verzeichnis: ['WE', 'MO', 'FR'],
  outreach: ['WE', 'TU', 'TH'],
  launch: ['TU', 'WE', 'TH'],
}

export const DEFAULT_TIME: Record<string, string | null> = {
  community: '09:00',
  social: '11:00',
  content: '10:00',
  verzeichnis: null,
  outreach: '13:00',
  launch: '09:00',
}

export const CATEGORY_DRAFT: Partial<Record<Category, DraftKind>> = {
  community: 'post',
  social: 'post',
  content: 'article',
  verzeichnis: 'text',
  outreach: 'mail',
  launch: 'text',
}

export const CATEGORY_STEPS: Partial<Record<Category, { agent: string, human: string, estimate: number }>> = {
  community: { agent: 'Passenden Thread suchen, Regeln prüfen, hilfreiche Antwort entwerfen', human: 'Prüfen und selbst posten', estimate: 10 },
  social: { agent: 'Beitrag entwerfen', human: 'Prüfen und posten', estimate: 5 },
  content: { agent: 'Artikel/Seite komplett entwerfen', human: 'Prüfen, ergänzen, veröffentlichen', estimate: 30 },
  verzeichnis: { agent: 'Eintragstexte vorbereiten (kurz, lang, Kategorien)', human: 'Eintrag im Formular einreichen', estimate: 15 },
  outreach: { agent: 'Passenden Kontakt recherchieren, persönliche Mail entwerfen', human: 'Prüfen und senden', estimate: 10 },
  launch: { agent: 'Launch vorbereiten: Texte, Zeitplan, FAQ-Antworten', human: 'Prüfen, Launch begleiten', estimate: 30 },
}

export function clampWeight(n: number): number {
  return Math.max(1, Math.min(MAX_WEIGHT, Math.round(n)))
}

export function freqLevel(perWeek: number): number {
  if (perWeek < 0.15) return 0
  let best = 1
  for (const [lvl, f] of Object.entries(WEIGHT_PER_WEEK)) {
    if (Math.abs(f - perWeek) < Math.abs(WEIGHT_PER_WEEK[best]! - perWeek)) best = Number(lvl)
  }
  return best
}

export function fillDays(days: string[] | undefined, category: string): string[] {
  const out = (days ?? []).map(d => d.toUpperCase()).filter(d => (WEEKDAY_CODES as readonly string[]).includes(d))
  for (const d of [...(DEFAULT_DAYS[category] ?? []), 'MO', 'TU', 'WE', 'TH', 'FR']) if (!out.includes(d)) out.push(d)
  return out
}

export function cadenceRule(level: number, days: string[], category = 'social'): string | null {
  if (level <= 0) return null
  const d = fillDays(days, category)
  if (level === 1) return `monthly:2${d[0]}`
  if (level === 2) return `biweekly:${d[0]}`
  if (level === 3) return `weekly:${d[0]}`
  if (level === 4) return `weekly:${d.slice(0, 2).join(',')}`
  if (level === 5) return `weekly:${d.slice(0, 3).join(',')}`
  return 'weekdays'
}

export interface GoalMetricPreset {
  key: string
  label: string
  mode: 'sum' | 'last' | 'month'
}

export const GOAL_METRICS: GoalMetricPreset[] = [
  { key: 'signups', label: 'Registrierungen', mode: 'sum' },
  { key: 'visitors', label: 'Besucher pro Monat', mode: 'month' },
  { key: 'sales', label: 'Verkäufe', mode: 'sum' },
  { key: 'customers', label: 'Zahlende Kunden gesamt', mode: 'last' },
  { key: 'trials', label: 'Testkonten', mode: 'sum' },
  { key: 'newsletter', label: 'Newsletter-Abonnenten', mode: 'last' },
  { key: 'followers', label: 'Follower', mode: 'last' },
  { key: 'referring_domains', label: 'Verweisende Domains', mode: 'last' },
  { key: 'artists', label: 'Künstler-Registrierungen', mode: 'sum' },
  { key: 'plays', label: 'Gehörte Titel', mode: 'sum' },
]

export interface GoalSuggestion {
  label: string
  metricKey: string
  mode: 'sum' | 'last' | 'month'
  target: number
}

export function suggestGoals(text: string): GoalSuggestion[] {
  const s = text.toLowerCase()
  const out: GoalSuggestion[] = []
  const add = (label: string, metricKey: string, mode: GoalSuggestion['mode'], target: number) => {
    if (!out.some(o => o.metricKey === metricKey)) out.push({ label, metricKey, mode, target })
  }
  if (/künstler|artist|musiker|band/.test(s)) add('Künstler-Registrierungen', 'artists', 'sum', 20)
  if (/musik|music|song|lied|hör|stream|audio/.test(s)) add('Gehörte Titel', 'plays', 'sum', 1000)
  if (/shop|kauf|verkauf|sale|store|preis|eur|€/.test(s)) add('Verkäufe', 'sales', 'sum', 10)
  if (/saas|abo|tarif|test|trial|kostenlos testen/.test(s)) add('Testkonten', 'trials', 'sum', 30)
  if (/newsletter/.test(s)) add('Newsletter-Abonnenten', 'newsletter', 'last', 100)
  add('Registrierungen', 'signups', 'sum', 50)
  add('Besucher pro Monat', 'visitors', 'month', 1000)
  add('Follower', 'followers', 'last', 200)
  return out.slice(0, 6)
}

export function parseNumber(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = raw.replace(/\s/g, '').match(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)/)
  if (!m) return null
  const v = m[1]!
  const n = /^\d{1,3}([.,]\d{3})+$/.test(v) ? Number(v.replace(/[.,]/g, '')) : Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export interface GoalProgress {
  current: number
  target: number
  pct: number
  expectedPct: number | null
  state: 'done' | 'on_track' | 'behind' | 'open'
}

export function goalProgress(current: number, target: number | null, startDate: string | null, deadline: string | null, today: string): GoalProgress {
  const t = target && target > 0 ? target : 0
  const pct = t ? Math.min(100, Math.round((current / t) * 100)) : 0
  let expected: number | null = null
  if (startDate && deadline && deadline > startDate) {
    const total = (parseIso(deadline).getTime() - parseIso(startDate).getTime()) / 86400000
    const done = (parseIso(today).getTime() - parseIso(startDate).getTime()) / 86400000
    expected = Math.max(0, Math.min(100, Math.round((done / total) * 100)))
  }
  let state: GoalProgress['state'] = 'open'
  if (t && current >= t) state = 'done'
  else if (expected !== null && expected >= 10) state = pct >= expected * 0.7 ? 'on_track' : 'behind'
  return { current, target: t, pct, expectedPct: expected, state }
}

export function monthWindow(today: string): { from: string, to: string } {
  return { from: addDays(today, -29), to: today }
}

export const AUTONOMY_KINDS = ['social', 'content', 'verzeichnis', 'mail', 'community', 'outreach'] as const
export type AutonomyKindT = typeof AUTONOMY_KINDS[number]
export const FIXED_APPROVAL: AutonomyKindT[] = ['community', 'outreach', 'mail']

export function autonomyKindOf(category: string, draftKind: string | null): AutonomyKindT | null {
  if (category === 'community') return 'community'
  if (category === 'outreach') return 'outreach'
  if (draftKind === 'mail') return 'mail'
  if (category === 'social') return 'social'
  if (category === 'content') return 'content'
  if (category === 'verzeichnis') return 'verzeichnis'
  return null
}

// Entwurfsvorlauf je Projekt: so viele Tage vor dem Termin entstehen Entwürfe (Freigabe im Voraus).
export const DRAFT_AHEAD_DEFAULT = 7
export const DRAFT_AHEAD_MAX = 21

export function draftAheadOf(setup: { draftAhead?: number | null } | null | undefined): number {
  const n = setup?.draftAhead
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(DRAFT_AHEAD_MAX, Math.max(1, Math.floor(n))) : DRAFT_AHEAD_DEFAULT
}
