import { addDays, minutesOf, timeOf } from '../../shared/utils/dates'

export interface IcalTask {
  id: string
  code: string
  title: string
  dueDate: string
  dueTime: string | null
  durationMin: number
  status: string
  project: string | null
  url: string
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

function fold(line: string): string {
  const out: string[] = []
  let rest = line
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--
    out.push(rest.slice(0, cut))
    rest = ` ${rest.slice(cut)}`
  }
  out.push(rest)
  return out.join('\r\n')
}

const ymd = (d: string) => d.replace(/-/g, '')
const hm = (t: string) => `${t.replace(':', '')}00`

export function buildIcal(name: string, timezone: string, tasks: IcalTask[], stamp: Date): string {
  const now = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aimarage//DE', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${timezone}`]
  for (const t of tasks) {
    lines.push('BEGIN:VEVENT', `UID:${t.id}@marketingagent`, `DTSTAMP:${now}`)
    if (t.dueTime) {
      const end = Math.min(minutesOf(t.dueTime) + t.durationMin, 23 * 60 + 59)
      lines.push(`DTSTART;TZID=${timezone}:${ymd(t.dueDate)}T${hm(t.dueTime)}`, `DTEND;TZID=${timezone}:${ymd(t.dueDate)}T${hm(timeOf(end))}`)
    }
    else {
      lines.push(`DTSTART;VALUE=DATE:${ymd(t.dueDate)}`, `DTEND;VALUE=DATE:${ymd(addDays(t.dueDate, 1))}`)
    }
    const done = t.status === 'erledigt' || t.status === 'ausgewertet'
    lines.push(`SUMMARY:${esc(`${done ? '[x] ' : ''}${t.project ? `${t.project}: ` : ''}${t.title}`)}`, `DESCRIPTION:${esc(`${t.code} - ${t.status}`)}`, `URL:${t.url}`, 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(fold).join('\r\n')}\r\n`
}
