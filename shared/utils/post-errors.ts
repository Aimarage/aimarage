// Feste Fehlertexte beim Posten über gehostete Dienste: deutsch gespeichert (Ergebnis, Notiz), für die Oberfläche je Sprache übersetzt.
// Ohne Namen des Dienstleisters, damit Kunden nur Aimarage und die Plattform sehen.

export const POST_ERROR = {
  unavailable: { de: 'gerade nicht verfügbar, wir kümmern uns darum', en: 'currently unavailable, we are looking into it' },
  busy: { de: 'zu viele Anfragen bei der Plattform, bitte später erneut posten', en: 'too many requests at the platform, please post again later' },
  offline: { de: 'Posten gerade nicht erreichbar, bitte später erneut posten', en: 'posting currently unreachable, please post again later' },
  reconnect: { de: 'Zugang abgelaufen, bitte das Konto unter Konten neu verbinden', en: 'access expired, please reconnect the account under Accounts' },
  duplicate: { de: 'gleicher Text wurde schon gepostet, bitte etwas ändern', en: 'the same text was already posted, please change something' },
  tooLong: { de: 'Text zu lang für die Plattform', en: 'text too long for the platform' },
  media: { de: 'Bild oder Video nicht angenommen (Format oder Größe)', en: 'image or video not accepted (format or size)' },
  rejected: { de: 'von der Plattform abgelehnt, bitte Text prüfen und erneut posten', en: 'rejected by the platform, please check the text and post again' },
  notFound: { de: 'Beitrag beim Posten nicht mehr gefunden', en: 'post no longer found while posting' },
  noAnswer: { de: 'keine Rückmeldung der Plattform', en: 'no response from the platform' },
  noService: { de: 'Dienst zum Posten nicht mehr verbunden', en: 'posting service no longer connected' },
  budget: { de: 'Budget für Dienste für diesen Monat aufgebraucht, X-Beitrag nicht gesendet', en: 'service budget for this month used up, X post not sent' },
} as const

export type PostErrorKey = keyof typeof POST_ERROR

const PAIRS = Object.values(POST_ERROR).sort((a, b) => b.de.length - a.de.length)

export function postErrorText(text: string | null | undefined, locale: 'de' | 'en'): string {
  if (!text) return ''
  if (locale !== 'en') return text
  let out = text
  for (const p of PAIRS) out = out.split(p.de).join(p.en)
  return out
    .replace(/\(nötig ca\. ([\d.]+) EUR, übrig ([\d.]+) EUR\)/g, '(needs about $1 EUR, $2 EUR left)')
    .replace(/^Posten fehlgeschlagen: /, 'Posting failed: ')
}
