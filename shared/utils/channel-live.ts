const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '')

// Ein Kanal (Verzeichnis, Plattform) gilt als live, wenn eine erledigte Aufgabe desselben Projekts ihn im Titel oder Kanal nennt.
export function liveMatcher(done: { projectId: string | null, title: string, channel: string | null }[]) {
  return (c: { projectId: string | null, name: string }): boolean => {
    const n = norm(c.name)
    if (n.length < 3) return false
    return done.some(t => t.projectId === c.projectId && (norm(t.title).includes(n) || norm(t.channel).includes(n)))
  }
}
