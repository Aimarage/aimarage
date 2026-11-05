export const TALK_SYSTEM = `Du bist der Marketing-Agent und sprichst mit dem Menschen, der deine Entwürfe freigibt, über eine Aufgabe und ihren Entwurf. Du bist kurz, freundlich und konkret, wie ein Kollege im Chat.
- Fragen beantwortest du direkt aus den Daten unten, ohne Gegenfrage. Weißt du etwas nicht, sag das und mach einen konkreten Vorschlag.
- Antworte in der Sprache, in der der Mensch schreibt, in Du-Form.
- Nichts erfinden: Fakten nur aus den Projektdaten und aus dem, was der Mensch sagt.
- Nur normale Bindestriche (-), keine langen Gedankenstriche.`

const STATUS_TEXT: Record<string, string> = {
  geplant: 'geplant, noch kein fertiger Entwurf',
  entwurf_fertig: 'Entwurf wartet auf Freigabe',
  freigegeben: 'freigegeben, noch nicht veröffentlicht',
  wartet: 'wartet',
  erledigt: 'erledigt',
  ausgewertet: 'ausgewertet',
  verworfen: 'verworfen',
}

export interface TalkPromptInput {
  project: { name: string, url: string | null, description: string | null, tonality: string | null, pages?: string[] } | null
  task: { code: string, title: string, description: string | null, channel: string | null, language: string | null, category?: string, status?: string, dueDate?: string | null, humanStep?: string | null }
  where?: string | null
  askedBefore?: boolean
  facts: { known: string[], avoid: string[] }
  memory: string[]
  draft: { version: number, status: string, kind: string, subject: string | null, body: string, variants: Record<string, string> } | null
  notes: string[]
  history: string[]
  message: string
  canRevise: boolean
  schedule?: string | null
  mail?: string | null
}

export function talkPrompt(i: TalkPromptInput): string {
  const p = i.project
  const d = i.draft
  const variants = d ? Object.entries(d.variants).filter(([, v]) => v?.trim()) : []
  const lines = [
    p ? `Projekt: ${p.name}${p.url ? ` (${p.url})` : ''}` : 'Projekt: übergreifend',
    p?.description ? `Worum es geht: ${p.description}` : '',
    p?.tonality ? `Tonalität: ${p.tonality}` : '',
    p?.pages?.length ? `Seiten der Projekt-Website:\n${p.pages.map(x => `- ${x}`).join('\n')}` : '',
    i.facts.known.length ? `Sichere Fakten:\n${i.facts.known.map(f => `- ${f}`).join('\n')}` : '',
    i.facts.avoid.length ? `Nicht sagen:\n${i.facts.avoid.map(f => `- ${f}`).join('\n')}` : '',
    i.memory.length ? `Wissen zum Projekt:\n${i.memory.map(m => `- ${m}`).join('\n')}` : '',
    '',
    `Aufgabe ${i.task.code}: ${i.task.title}`,
    i.task.description ? `Details: ${i.task.description}` : '',
    i.mail ? `${i.mail}\nFragen zur Mail (Datum, Absender, frühere Mails) beantwortest du aus diesen Daten. Sag nicht, du hättest keinen Einblick ins Postfach. Fehlt ein Wert, sag ehrlich, dass er nicht gespeichert ist.` : '',
    i.task.category ? `Kategorie: ${i.task.category}` : '',
    i.task.channel ? `Kanal: ${i.task.channel}` : '',
    i.where ? `Wo es erscheint: ${i.where}` : '',
    i.task.status ? `Status: ${STATUS_TEXT[i.task.status] ?? i.task.status}${i.task.dueDate ? `, fällig ${i.task.dueDate}` : ''}` : '',
    i.task.humanStep ? `Schritt des Menschen: ${i.task.humanStep}` : '',
    i.task.language ? `Sprache des Entwurfs: ${i.task.language}` : '',
    i.schedule ? `\nTermin und Takt:\n${i.schedule}` : '',
    '',
    d ? `Aktueller Entwurf (Version ${d.version}, ${d.status}, ${d.kind}):${d.subject ? `\nBetreff: ${d.subject}` : ''}\n${d.body.slice(0, 4000)}` : 'Es gibt noch keinen Entwurf.',
    ...variants.map(([k, v]) => `Fassung ${k}:\n${v.slice(0, 1500)}`),
    i.notes.length ? `\nNotizen zur Aufgabe:\n${i.notes.map(n => `- ${n}`).join('\n')}` : '',
    i.history.length ? `\nBisheriges Gespräch:\n${i.history.join('\n')}` : '',
    '',
    `Neue Nachricht des Menschen: ${i.message}`,
    '',
    'Entscheide genau eins:',
    '- "answer": Er fragt etwas (z.B. "Wo posten wir das?", "Warum so?", "Wann geht das raus?"). Antworte sofort und direkt in 1-3 Sätzen aus den Daten oben. Fehlt etwas (z.B. kein Ziel festgelegt), sag das klar und nenne deinen Vorschlag.',
    i.askedBefore
      ? '- "ask": Nicht mehr möglich, du hast schon nachgefragt. Entscheide selbst und antworte mit "answer" oder "revise".'
      : '- "ask": Nur wenn die Nachricht wirklich mehrdeutig ist und du ohne Klärung nichts Sinnvolles tun kannst. Eine kurze Rückfrage, höchstens einmal im Gespräch.',
    i.canRevise
      ? '- "revise": Es ist klar, was die neue Version anders machen soll. Bestätige kurz und fasse in einem Satz zusammen, was du änderst, z.B. "Alles klar: kürzer und ohne Hashtags. Ich schreibe eine neue Version." Eine klare Anweisung ("Mach es kürzer", "Kein Hashtag") oder eine Antwort auf deine Frage beantwortest du sofort mit "revise", ohne unnötig nachzufragen.'
      : '- Eine neue Version ist gerade nicht möglich (Aufgabe abgeschlossen). Antworte mit "answer".',
    'Optional "convert": "article", wenn aus dieser Aufgabe ein Blog-Artikel werden soll (z.B. "Mach einen Blogbeitrag daraus"), oder "post", wenn daraus ein Social-Post werden soll. Du stellst Kategorie und Art damit selbst um (Code, Verlauf und Links bleiben, ein Artikel hat keine Plattform-Fassungen und erscheint im Blog). Sag nie, dass nur der Mensch das umstellen kann. Wird neu geschrieben, zusätzlich "revise".',
    'Optional "posts": true, wenn der Mensch zu einem Artikel Social-Posts will, die darauf verweisen. Bei "convert": "article" entstehen sie ohnehin automatisch als eigene Aufgabe; sie werden geschrieben, sobald der Artikel veröffentlicht ist, mit Link darauf. Frag dazu nicht nach.',
    ...(i.schedule
      ? [
          'Handeln statt nur bestätigen: Sagt der Mensch "heute nicht", "nicht mehr", "später", "will ich nicht" oder dass er dort heute schon etwas gepostet hat, tust du selbst etwas. Nie nur "Alles klar" und den Termin stehen lassen; ein Entwurf bleibt nie mit dem heutigen oder einem überfälligen Datum liegen, wenn er heute nicht kommt.',
          '- Soll es nur später kommen (heute nicht, später, schon gepostet): "move": "YYYY-MM-DD" mit einem Tag nach heute, der zu Takt, Mindestabstand und Regeln oben passt, meist der genannte nächste sinnvolle Tag. Im Text kurz sagen, worauf du verschoben hast und warum, z.B. "Verschoben auf Do 29.10., dann ist genug Abstand zu deinem Video."',
          '- Will er den Beitrag gar nicht mehr: "drop": true. Im Text kurz sagen, dass die Aufgabe verworfen ist und nichts rausgeht.',
          i.askedBefore
            ? '- Unklar, ob später oder gar nicht: Du hast schon gefragt, entscheide selbst (im Zweifel verschieben).'
            : '- Unklar, ob später oder gar nicht: "ask" mit genau einer kurzen Frage und zwei Wegen, z.B. "Verschiebe ich auf Do 29.10. oder lassen wir den Post ganz weg?". Dann weder move noch drop.',
          'Bittet er ausdrücklich um einen Tag ("am Dienstag", "nächste Woche"), "move" auf diesen Tag.',
        ]
      : []),
    'Optional "block": Plattform-Schlüssel (z.B. "linkedin", "mastodon", "x"), wenn der Mensch eine Plattform für dieses Projekt ganz ausschließt (z.B. "Ich lege keine LinkedIn-Seite an", "Mastodon ist gesperrt", "nie mehr auf X"). Das streicht die Plattform dauerhaft: keine Aufgaben, Posts, Konto-Aufgaben oder Meldungen mehr dafür, diese Aufgabe fällt weg. Im Text kurz bestätigen, z.B. "Alles klar, LinkedIn ist für dieses Projekt gestrichen, ich plane nichts mehr dafür." Nur bei klarer Absage, nicht bei "heute nicht".',
    'Optional "fact": nur wenn der Mensch etwas sagt, das für das ganze Projekt dauerhaft gilt (z.B. "Wir nennen nie Preise"), als kurzer Satz, den man sich merken sollte. Sonst leer lassen. Nichts, was schon in den Fakten steht.',
    '',
    i.schedule
      ? 'Antworte nur mit einem JSON-Objekt: {"type": "answer" | "ask" | "revise", "text": "deine Nachricht an den Menschen", "fact": "", "convert": null, "posts": false, "move": null, "drop": false, "block": null}'
      : 'Antworte nur mit einem JSON-Objekt: {"type": "answer" | "ask" | "revise", "text": "deine Nachricht an den Menschen", "fact": "", "convert": null, "posts": false, "block": null}',
  ]
  return lines.filter(l => l !== '').join('\n')
}
