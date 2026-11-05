export interface PlanTable {
  headers: string[]
  rows: Record<string, string>[]
}

export interface PlanPhaseTask {
  id: string
  title: string
  agent: string | null
  human: string | null
  effort: string | null
  product: string
}

export interface PlanGoal {
  product: string
  label: string
  target3m: string
  target12m: string
}

export interface PlanWeek {
  week: number
  date: string
  focus: string
  theme: string
  highlight: string
  contentId: string | null
}

export interface PlanBacklogItem {
  id: string
  product: string
  type: string
  title: string
  keyword: string
  language: string
  prio: 'P1' | 'P2' | 'P3'
}

export interface PlanChannel {
  product: string
  group: string
  name: string
  done: boolean
}

export interface PlanData {
  startDate: string | null
  goals: PlanGoal[]
  phase0: PlanPhaseTask[]
  weeks: PlanWeek[]
  backlog: PlanBacklogItem[]
  channels: PlanChannel[]
}

export const PRODUCT_CODES: Record<string, string> = {
  chatsite: 'AMW',
  linkbox: 'BMX',
  tonebase: 'BIT',
}

function clean(cell: string): string {
  return cell.replace(/\*\*/g, '').replace(/`/g, '').trim()
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map(clean)
}

export function parseTables(md: string): { heading: string, table: PlanTable }[] {
  const lines = md.split(/\r?\n/)
  const out: { heading: string, table: PlanTable }[] = []
  let heading = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      heading = h[1]!.trim()
      continue
    }
    if (!line.trim().startsWith('|')) continue
    const next = lines[i + 1] ?? ''
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(next)) continue
    const headers = splitRow(line)
    const rows: Record<string, string>[] = []
    let j = i + 2
    for (; j < lines.length && lines[j]!.trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j]!)
      const row: Record<string, string> = {}
      headers.forEach((key, idx) => {
        row[key] = cells[idx] ?? ''
      })
      rows.push(row)
    }
    out.push({ heading, table: { headers, rows } })
    i = j - 1
  }
  return out
}

function dash(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  return t === '' || t === '-' ? null : t
}

function productFromHeading(heading: string): string {
  const h = heading.toLowerCase()
  if (h.includes('chatsite')) return 'AMW'
  if (h.includes('linkbox')) return 'BMX'
  if (h.includes('tonebase')) return 'BIT'
  return 'ALLE'
}

function productFromCell(v: string): string {
  const t = v.trim().toUpperCase()
  return ['AMW', 'BMX', 'BIT'].includes(t) ? t : 'ALLE'
}

const GERMAN_DATE = /(\d{1,2})\.(\d{1,2})\.(\d{4})/

export function parsePlan(md: string): PlanData {
  const tables = parseTables(md)
  const data: PlanData = { startDate: null, goals: [], phase0: [], weeks: [], backlog: [], channels: [] }

  const start = /Start der Dauerkampagne:[^0-9]*(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(md)
  if (start) data.startDate = `${start[3]}-${start[2]!.padStart(2, '0')}-${start[1]!.padStart(2, '0')}`

  for (const { heading, table } of tables) {
    const hs = table.headers
    if (hs.includes('Messgröße') && hs.includes('Produkt') && hs.some(h => h.startsWith('3 Monate'))) {
      const k3 = hs.find(h => h.startsWith('3 Monate'))!
      const k12 = hs.find(h => h.startsWith('12 Monate'))!
      for (const r of table.rows) data.goals.push({ product: productFromCell(r.Produkt ?? ''), label: r['Messgröße'] ?? '', target3m: r[k3] ?? '', target12m: r[k12] ?? '' })
      continue
    }
    if (hs[0] === 'ID' && hs.includes('Aufgabe')) {
      const product = productFromHeading(heading)
      for (const r of table.rows) {
        if (!/^[A-Z]-\d+$/.test(r.ID ?? '')) continue
        data.phase0.push({ id: r.ID!, title: r.Aufgabe ?? '', agent: dash(r.Agent), human: dash(r.Peter), effort: dash(r.Aufwand), product })
      }
      continue
    }
    if (hs[0] === 'Wo' && hs.includes('Fokus')) {
      const contentKey = hs.find(h => h.startsWith('Content'))
      const highlightKey = hs.find(h => h.startsWith('Launch'))
      const year = data.startDate?.slice(0, 4) ?? String(new Date().getFullYear())
      for (const r of table.rows) {
        const week = Number(r.Wo)
        if (!week) continue
        const dm = /(\d{1,2})\.(\d{1,2})\./.exec(r.Datum ?? '')
        const date = dm ? `${year}-${dm[2]!.padStart(2, '0')}-${dm[1]!.padStart(2, '0')}` : ''
        const content = contentKey ? /C-\d+/.exec(r[contentKey] ?? '')?.[0] ?? null : null
        data.weeks.push({ week, date, focus: productFromCell(r.Fokus ?? ''), theme: r.Schwerpunkt ?? '', highlight: highlightKey ? r[highlightKey] ?? '' : '', contentId: content })
      }
      fixYearRollover(data.weeks)
      continue
    }
    if (hs[0] === '#' && hs.includes('Prio')) {
      const titleKey = hs.find(h => h.startsWith('Titel')) ?? 'Titel'
      const kwKey = hs.find(h => h.startsWith('Haupt')) ?? 'Keyword'
      for (const r of table.rows) {
        const prio = (r.Prio ?? 'P2').trim() as PlanBacklogItem['prio']
        data.backlog.push({ id: r['#']!, product: productFromCell(r.Produkt ?? ''), type: r.Typ ?? '', title: r[titleKey] ?? '', keyword: r[kwKey] ?? '', language: r.Sprache ?? '', prio: ['P1', 'P2', 'P3'].includes(prio) ? prio : 'P2' })
      }
    }
  }

  data.channels = parseChannels(md)
  return data
}

function fixYearRollover(weeks: PlanWeek[]): void {
  for (let i = 1; i < weeks.length; i++) {
    const prev = weeks[i - 1]!.date
    const cur = weeks[i]!.date
    if (prev && cur && cur < prev) weeks[i]!.date = `${Number(cur.slice(0, 4)) + 1}${cur.slice(4)}`
  }
}

export function parseChannels(md: string): PlanChannel[] {
  const out: PlanChannel[] = []
  const section = md.split(/^## /m).find(s => s.startsWith('7.'))
  if (!section) return out
  let product = 'ALLE'
  let group = ''
  for (const line of section.split(/\r?\n/)) {
    const h = /^###\s+(.*)$/.exec(line)
    if (h) {
      product = productFromHeading(h[1]!)
      group = ''
      continue
    }
    const g = /^\*\*(.+?)\*\*\s*$/.exec(line.trim())
    if (g) {
      group = g[1]!.trim()
      continue
    }
    const item = /^-\s+\[( |x)\]\s+(.*)$/.exec(line.trim())
    if (item && group) {
      const name = item[2]!.replace(/\s+-\s+\[ \].*$/, '').trim()
      out.push({ product, group, name, done: item[1] === 'x' })
    }
  }
  return out
}

export function germanDateToIso(v: string): string | null {
  const m = GERMAN_DATE.exec(v)
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null
}
