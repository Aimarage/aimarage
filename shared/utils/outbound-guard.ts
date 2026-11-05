// Wächter vor jedem Senden/Posten: interne Agenten-Notizen und falsche Sprache gehen nie nach außen.

export type TextLang = 'de' | 'en'

const TASK_CODE = /\b[A-Z]{2,5}-[A-Z]{2,5}-\d{3,4}\b/
const INTERNAL: { re: RegExp, label: string }[] = [
  { re: /\bkein(?:e|en)?\s+(?:versand|antwort|mail|post|beitrag)\b\s*[:.(-]/i, label: '"Kein Versand"' },
  { re: /\bnicht\s+(?:senden|versenden|abschicken|posten|veröffentlichen|beantworten)\b/i, label: '"nicht senden"' },
  { re: /\bwird nicht bearbeitet\b/i, label: '"wird nicht bearbeitet"' },
  { re: /\blaut\s+projekt-?\s?regel/i, label: '"laut Projektregel"' },
  { re: /\bprojekt-?regeln?\b.*\b(?:ausgeschlossen|verbieten|verbietet|untersagt)\b/i, label: 'Verweis auf Projekt-Regeln' },
  { re: /\baufgabe\s+(?:schließen|schliessen|verwerfen|entfällt)\b/i, label: '"Aufgabe schließen"' },
  { re: /\b(?:ki-prüfer|nachprüfung|freigabe-stufe|info nötig)\b/i, label: 'Aimarage-Begriff' },
  { re: /\b(?:do not|don't|dont)\s+(?:send|reply|post|publish)\b/i, label: '"do not send"' },
  { re: /\bno\s+(?:reply|response|answer)\s+(?:needed|necessary|required)\b/i, label: '"no reply needed"' },
  { re: /\b(?:per|according to)\s+(?:the\s+)?project\s+rules?\b/i, label: '"per project rule"' },
  { re: /\b(?:internal note|interne notiz)\b/i, label: '"interne Notiz"' },
]

// Strenge Merkmale einer internen Notiz (Aufgaben-Codes, "Kein Versand", "laut Projektregel" ...).
export function internalTextProblems(texts: (string | null | undefined)[]): string[] {
  const all = texts.filter(Boolean).join('\n')
  if (!all.trim()) return []
  const hits: string[] = []
  const code = all.match(TASK_CODE)
  if (code) hits.push(`Aufgaben-Code ${code[0]}`)
  for (const p of INTERNAL) if (p.re.test(all)) hits.push(p.label)
  return hits.length ? [`Text sieht nach interner Notiz aus (${[...new Set(hits)].join(', ')}), bitte prüfen`] : []
}

const DE = new Set(['und', 'der', 'die', 'das', 'ist', 'nicht', 'ich', 'wir', 'mit', 'für', 'auf', 'wird', 'eine', 'einen', 'laut', 'auch', 'sich', 'dem', 'den', 'des', 'zu', 'von', 'bei', 'nur', 'noch', 'aber', 'oder', 'wenn', 'sind', 'hat', 'haben', 'euch', 'dich', 'dir', 'uns', 'unser', 'unsere', 'gerne', 'danke', 'schon', 'über', 'höchstens', 'erhält', 'kein', 'keine'])
const EN = new Set(['the', 'and', 'is', 'to', 'of', 'you', 'we', 'for', 'with', 'this', 'that', 'are', 'it', 'our', 'your', 'on', 'in', 'be', 'have', 'has', 'thanks', 'thank', 'just', 'from', 'will', 'can', 'if', 'but', 'or', 'not', 'at', 'as', 'so', 'us', 'my', 'all', 'about', 'would', 'love', 'hi', 'hey', 'hello'])

// Grobe Spracherkennung Deutsch/Englisch über häufige Wörter; null wenn unklar oder zu kurz.
export function detectLang(text: string | null | undefined): TextLang | null {
  const words = (text ?? '').replace(/https?:\/\/\S+/g, ' ').toLowerCase().match(/[a-zäöüß']+/g) ?? []
  if (words.length < 6) return null
  let de = 0
  let en = 0
  for (const w of words) {
    if (DE.has(w)) de++
    if (EN.has(w)) en++
  }
  if (/[äöüß]/i.test(text ?? '')) de += 2
  if (de + en < 3) return null
  if (de >= 2 * en + 2) return 'de'
  if (en >= 2 * de + 2) return 'en'
  return null
}

// Sprache passt nicht: erkannte Sprache ist keine der erwarteten (z.B. Deutsch an englischen Kontakt).
export function languageProblem(text: string | null | undefined, expected: (string | null | undefined)[]): string | null {
  const want = [...new Set(expected.map(l => (l ?? '').toLowerCase().slice(0, 2)).filter(l => l === 'de' || l === 'en'))]
  if (!want.length) return null
  const got = detectLang(text)
  if (!got || want.includes(got)) return null
  const name = (l: string) => (l === 'de' ? 'Deutsch' : 'Englisch')
  return `Sprache passt nicht: Text ist ${name(got)}, erwartet ${want.map(name).join(' oder ')}, bitte prüfen`
}

export function outboundProblems(texts: (string | null | undefined)[], expectedLangs: (string | null | undefined)[] = []): string[] {
  const out = internalTextProblems(texts)
  const main = texts.filter(Boolean).join('\n')
  const lang = languageProblem(main, expectedLangs)
  if (lang) out.push(lang)
  return out
}

// Erwartete Sprache: die einer eingegangenen Nachricht (Antwort an einen Kontakt), sonst Aufgabe, sonst Projekt.
export function expectedLangs(task: { language?: string | null }, project: { languages?: string[] | null } | null, incoming?: string | null): string[] {
  const got = incoming ? detectLang(incoming) : null
  if (got) return [got]
  if (task.language) return [task.language]
  return project?.languages ?? []
}
