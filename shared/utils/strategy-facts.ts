export const DEFAULT_MINUTES_PER_DAY = 15

// Zeitbudget des Menschen in Minuten pro Tag (Einstellung je Person, Standard 15).
export function minutesPerDay(settings: object | null | undefined, userId: string | null | undefined): number {
  const n = userId ? (settings as { timeBudget?: Record<string, number> } | null | undefined)?.timeBudget?.[userId] : undefined
  return typeof n === 'number' && n >= 1 ? Math.floor(n) : DEFAULT_MINUTES_PER_DAY
}

const HOURS = /\b\d+(?:[.,]\d+)?\s*(?:-\s*\d+(?:[.,]\d+)?\s*)?(?:Stunden|Std\.?|hours?)\b/i

export function budgetSentence(minutes: number): string {
  return `Der Takt passt in ${minutes} Minuten pro Tag für Prüfen und Freigeben, das Schreiben übernimmt der Agent.`
}

// Erfundene Stundenangaben ("25-30 Stunden pro Woche") durch das echte Zeitbudget ersetzen.
export function fixTimeClaims(text: string, minutes: number): string {
  if (!text || !HOURS.test(text)) return text
  const out: string[] = []
  for (const s of text.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ])/)) {
    const next = HOURS.test(s) ? budgetSentence(minutes) : s
    if (out.at(-1) !== next) out.push(next)
  }
  return out.join(' ')
}
