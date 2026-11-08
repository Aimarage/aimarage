// Aufgabentitel, die mit einem rohen Pfad beginnen ("/ überarbeiten: ..."), lesbar machen: "Startseite überarbeiten: ...", "Seite „preise“ überarbeiten: ...".

const LEAD_PATH = /^\/(\S*)\s+(?=\S)/

export function pageLabel(path: string): string {
  const p = path.replace(/^\/+/, '').replace(/\/+$/, '')
  return p ? `Seite „${p}“` : 'Startseite'
}

export function taskTitle(title: string): string {
  const m = LEAD_PATH.exec(title)
  if (!m) return title
  return `${pageLabel(m[1]!)} ${title.slice(m[0].length)}`
}
