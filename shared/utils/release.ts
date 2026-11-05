export const RELEASE_KINDS = ['album', 'single', 'ep', 'launch'] as const
export type ReleaseKind = typeof RELEASE_KINDS[number]

export const RELEASE_KIND_LABEL: Record<ReleaseKind, { work: string, item: string }> = {
  album: { work: 'Album', item: 'Track' },
  single: { work: 'Single', item: 'Track' },
  ep: { work: 'EP', item: 'Track' },
  launch: { work: 'Produkt', item: 'Feature' },
}

export const MAX_RELEASE_ITEMS = 40

export function validDate(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
}
export const DEFAULT_RELEASE_TIME = '18:00'

const NUMBERED = /^\s*(?:[-*•]\s*)?(?:(?:track|titel|song|nr\.?|no\.?)\s*)?(\d{1,2})\s*(?:[.):\-]|\s)\s*(.+)$/i
const NUMBERED_MARK = /^\s*(?:[-*•]\s*)?(?:(?:track|titel|song|nr\.?|no\.?)\s*)?(\d{1,2})\s*[.):\-]\s*(.+)$/i
const BULLET = /^\s*[-*•]\s+(.+)$/
const DURATION = /\s*[([]?\b\d{1,2}:\d{2}\b[)\]]?\s*$/

function cleanItem(raw: string): string {
  return raw.replace(DURATION, '').replace(/\s*[-|]\s*$/, '').replace(/^["'„“”‚‘’]+|["'„“”‚‘’]+$/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function parseTrackList(text: string, opts: { strict?: boolean } = {}): string[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const out: string[] = []
  const push = (v: string) => {
    const c = cleanItem(v)
    if (c && !out.some(x => x.toLowerCase() === c.toLowerCase())) out.push(c)
  }
  if (opts.strict) {
    let run: string[] = []
    let last = 0
    const flush = () => {
      if (run.length >= 2) run.forEach(push)
      run = []
      last = 0
    }
    for (const line of lines) {
      const m = NUMBERED.exec(line)
      const n = m ? Number(m[1]) : 0
      if (m && n === last + 1) {
        run.push(m[2]!)
        last = n
        continue
      }
      flush()
      if (m && n === 1) {
        run.push(m[2]!)
        last = 1
      }
    }
    flush()
    return out.slice(0, MAX_RELEASE_ITEMS)
  }
  const parts = lines.length > 1 ? lines : (lines[0] ?? '').split(/\s*[;,]\s*/)
  for (const p of parts) {
    const m = NUMBERED_MARK.exec(p) ?? BULLET.exec(p)
    push(m ? m[m.length - 1]! : p)
  }
  return out.slice(0, MAX_RELEASE_ITEMS)
}

export interface WeekendPolicy {
  social: boolean
  human: boolean
}

const WEEKEND = /wochenend|weekend|samstag|sonntag|saturday|sunday|montag bis freitag|monday (?:to|through) friday|\bmo\s*-\s*fr\b|werktag|weekday/i
const ALLOW = /\b(?:auch|also|even)\b[^.]*\b(?:samstag|sonntag|wochenend\w*|weekends?|saturday|sunday)|\b(?:samstag|sonntag|wochenend\w*|weekends?)\b[^.]*\b(?:erlaubt|allowed|ok)\b/i
const DENY = /\b(?:kein\w*|nicht|nur|nie|no|not|only|never)\b/i
const HUMAN = /aufgaben,? die [^.]*braucht|\bmensch|human|tasks? (?:that|which) need|für peter|for peter/i
const POSTS = /\bposts?\b|beitr[äa]g|social/i

export function weekendPolicy(texts: (string | null | undefined)[]): WeekendPolicy {
  const out: WeekendPolicy = { social: true, human: false }
  for (const text of texts) {
    if (!text) continue
    for (const s of text.split(/(?<=[.!?])\s+|\n+/)) {
      if (!WEEKEND.test(s)) continue
      const humanOnly = HUMAN.test(s) && !POSTS.test(s)
      if (ALLOW.test(s)) {
        if (humanOnly) out.human = true
        else out.social = true
        continue
      }
      if (!DENY.test(s)) continue
      if (humanOnly) out.human = false
      else {
        out.social = false
        out.human = false
      }
    }
  }
  return out
}

export function isWeekend(weekdayNumber: number): boolean {
  return weekdayNumber >= 6
}

export function releaseSlug(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'release'
}
