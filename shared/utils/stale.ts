// Notiz-Präfixe beim Abgleich offener Aufgaben mit der Strategie.
export const STALE_HINT = 'Passt nicht mehr zur Strategie:'
export const STALE_DROP = 'Veraltet, automatisch verworfen:'
export const STALE_KEEP = 'Behalten:'

// Offener Hinweis: letzter Vorschlag zum Verwerfen ohne spätere Entscheidung "Behalten".
export function openStaleHint(notes: { text: string, createdAt: string | Date }[]): string | null {
  const hint = notes.filter(n => n.text.startsWith(STALE_HINT)).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0]
  if (!hint) return null
  const kept = notes.some(n => n.text.startsWith(STALE_KEEP) && +new Date(n.createdAt) >= +new Date(hint.createdAt))
  return kept ? null : hint.text.slice(STALE_HINT.length).replace(/\s*Verwerfen\?$/, '').trim()
}

// Verwerfungsgrund, der die ganze Aufgabe überflüssig macht (doppelt, entfällt, kein neuer Kontakt ...).
const OBSOLETE = /^\s*(doppelt|duplikat|dublette|duplicate)\b|doppelte (aufgabe|antwort|beitrag)|aufgabe (ist )?(doppelt|entfällt|überflüssig|erledigt)|\bentf[äa]llt\b|\büberflüssig\b|nicht mehr (nötig|notwendig|relevant|aktuell)|kein(en)? neue[nr]? kontakt|(schon|bereits) (erledigt|beantwortet|gepostet|geantwortet)|\bno longer (needed|relevant)\b|\bnot needed\b|\bobsolete\b|already (done|posted|answered|replied)/i

export function obsoleteReason(reason: string | null | undefined): boolean {
  return !!reason && OBSOLETE.test(reason)
}

export const OBSOLETE_DROP = 'Aufgabe entfällt laut Verwerfungsgrund:'
