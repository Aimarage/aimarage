import { addDays, weekday } from './dates'

export type SubPromo = 'yes' | 'no' | 'days' | 'unknown'

export interface SubRules {
  sub: string
  promo: SubPromo
  days: number[]
  flairRequired: boolean
  flair: string | null
  links: 'yes' | 'no' | 'unknown'
  notes: string[]
  source: 'api' | 'public' | 'search' | 'model'
  at: string
}

export const SUB_RULES_DAYS = 7

const DAY_NAMES_DE = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']
const DAY_WORDS: Record<string, number> = {
  mo: 1, mon: 1, monday: 1, montag: 1, tu: 2, tue: 2, tuesday: 2, dienstag: 2, we: 3, wed: 3, wednesday: 3, mittwoch: 3,
  th: 4, thu: 4, thursday: 4, donnerstag: 4, fr: 5, fri: 5, friday: 5, freitag: 5, sa: 6, sat: 6, saturday: 6, samstag: 6, su: 7, sun: 7, sunday: 7, sonntag: 7,
}

export function dayNumber(v: string | number): number | null {
  if (typeof v === 'number') return v >= 1 && v <= 7 ? Math.floor(v) : null
  return DAY_WORDS[v.trim().toLowerCase().replace(/s$/, '')] ?? null
}

export function subKey(sub: string): string {
  return sub.replace(/^\/?r\//i, '').toLowerCase()
}

export function freshRules(r: SubRules | null | undefined, nowMs = Date.now()): boolean {
  return !!r && nowMs - Date.parse(r.at) < SUB_RULES_DAYS * 86_400_000
}

// Darf an diesem Tag ein Beitrag über das eigene Produkt erscheinen?
export function promoDayOk(r: Pick<SubRules, 'promo' | 'days'>, date: string): boolean {
  return r.promo !== 'days' || !r.days.length || r.days.includes(weekday(date))
}

export function nextPromoDay(r: Pick<SubRules, 'promo' | 'days'>, date: string): string {
  let d = date
  for (let i = 0; i < 7 && !promoDayOk(r, d); i++) d = addDays(d, 1)
  return d
}

export function dayList(days: number[], lang: 'de' | 'en' = 'de'): string {
  const names = lang === 'de' ? DAY_NAMES_DE : ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  return days.map(d => names[d]).filter(Boolean).join(', ')
}

// Kurzfassung für Entwurf, Nachprüfung und Notizen
export function rulesText(r: SubRules): string {
  const promo = r.promo === 'no' ? 'Eigenwerbung verboten: kein Beitrag über das eigene Produkt, höchstens hilfreiche Antworten ohne Produkt'
    : r.promo === 'days' && r.days.length ? `Beiträge über eigene Projekte/Produkte nur am ${dayList(r.days)}${r.flair ? ` mit Flair "${r.flair}"` : ''}, sonst gilt es als Eigenwerbung`
      : r.promo === 'yes' ? 'Eigenwerbung erlaubt (mit Offenlegung, sparsam)'
        : 'Eigenwerbung: unklar, vorsichtig sein'
  return [
    `Regeln von r/${r.sub}${r.source === 'model' ? ' (aus Allgemeinwissen, ungeprüft)' : ''}:`,
    `- ${promo}`,
    r.flair || r.flairRequired ? `- Flair ${r.flairRequired ? 'Pflicht' : 'empfohlen'}${r.flair ? `: "${r.flair}"` : ''}` : '',
    r.links === 'no' ? '- Keine Links zum eigenen Produkt' : r.links === 'yes' ? '- Links erlaubt' : '',
    ...r.notes.map(n => `- ${n}`),
  ].filter(Boolean).join('\n')
}
