// KI-Kennzeichnung (Art. 50 Abs. 2 KI-VO): Bleibt eine vom Menschen bearbeitete Fassung KI-erzeugt?
// Ja, solange ein wesentlicher Teil der Wörter aus der KI-Fassung stammt. Schreibt der Mensch den Text neu, entfällt die Kennzeichnung.
export const AI_SHARE = 0.3

function words(t: string): string[] {
  return t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []
}

export function aiAfterEdit(prev: { aiGenerated: boolean, body: string } | null | undefined, body: string): boolean {
  if (!prev?.aiGenerated) return false
  const next = words(body)
  if (!next.length) return false
  const old = new Set(words(prev.body))
  return next.filter(w => old.has(w)).length / next.length >= AI_SHARE
}
