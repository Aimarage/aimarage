import { RELEASE_KIND_LABEL, type ReleaseKind } from './release'

export interface KnownRelease {
  title: string
  kind: ReleaseKind
  releaseDate: string
  items: string[]
}

export interface ReleaseFocus {
  current: KnownRelease
  older: KnownRelease[]
  upcoming: KnownRelease[]
}

export interface ReleaseHit {
  release: KnownRelease
  term: string
}

export const RELEASE_CHECK = 'Release prüfen:'

const MIN_TERM = 4

export function releaseFocus(list: KnownRelease[], day: string): ReleaseFocus | null {
  const sorted = list.filter(r => r.title && r.releaseDate).sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
  const current = sorted.find(r => r.releaseDate <= day)
  if (!current) return null
  return {
    current,
    older: sorted.filter(r => r.releaseDate < current.releaseDate),
    upcoming: sorted.filter(r => r.releaseDate > day).reverse(),
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[–—]/g, '-').replace(/[„“”‚‘’"']/g, '').replace(/\s+/g, ' ').trim()
}

export function releaseTerms(r: Pick<KnownRelease, 'title' | 'items'>): string[] {
  const out: string[] = []
  for (const t of [r.title, ...r.items]) {
    const c = t.replace(/[„“”‚‘’"]/g, '').replace(/\s+/g, ' ').trim()
    if (c.length >= MIN_TERM && !out.some(x => norm(x) === norm(c))) out.push(c)
  }
  return out
}

export function mentionsTerm(text: string, term: string): boolean {
  const t = norm(term)
  if (!t) return false
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u')
  return re.test(norm(text))
}

function freshTerms(f: ReleaseFocus): string[] {
  return [f.current, ...f.upcoming].flatMap(releaseTerms)
}

export function mentionsCurrent(text: string, f: ReleaseFocus): boolean {
  return freshTerms(f).some(t => mentionsTerm(text, t))
}

export function oldReleaseHits(text: string, f: ReleaseFocus): ReleaseHit[] {
  const fresh = freshTerms(f).map(norm)
  const out: ReleaseHit[] = []
  for (const release of f.older) {
    for (const term of releaseTerms(release)) {
      const n = norm(term)
      if (fresh.some(c => c.includes(n) || n.includes(c))) continue
      if (mentionsTerm(text, term)) out.push({ release, term })
    }
  }
  return out
}

export function oldReleaseHit(text: string, f: ReleaseFocus | null | undefined): ReleaseHit | null {
  if (!f || !f.older.length || mentionsCurrent(text, f)) return null
  return oldReleaseHits(text, f)[0] ?? null
}

function dmy(d: string): string {
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`
}

export function releaseLabel(r: Pick<KnownRelease, 'title' | 'kind' | 'releaseDate'>): string {
  return `${RELEASE_KIND_LABEL[r.kind]?.work ?? 'Release'} "${r.title}" (${dmy(r.releaseDate)})`
}

export function releaseHitText(hit: ReleaseHit, f: ReleaseFocus): string {
  const term = hit.term === hit.release.title ? `"${hit.term}"` : `"${hit.term}" (${hit.release.title})`
  return `${term}, aktuell: ${f.current.title}`
}

export function releaseRule(f: ReleaseFocus | null | undefined, opts: { exempt?: boolean } = {}): string {
  if (!f) return ''
  const { item } = RELEASE_KIND_LABEL[f.current.kind] ?? { item: 'Track' }
  const items = f.current.items.length ? `; ${item}s: ${f.current.items.slice(0, 12).join(', ')}${f.current.items.length > 12 ? ', ...' : ''}` : ''
  return [
    `AKTUELLES RELEASE: ${releaseLabel(f.current).replace(/\)$/, `${items})`)}. Es hat Vorrang: Beiträge, Themen und Planung drehen sich zuerst um dieses Release.`,
    f.older.length
      ? `Ältere Releases (${f.older.slice(0, 4).map(releaseLabel).join(', ')}) nur erwähnen, wenn die Aufgabe oder der Mensch sie ausdrücklich nennt; sonst ist das ein Fehler.`
      : 'Ältere Releases nur erwähnen, wenn die Aufgabe oder der Mensch sie ausdrücklich nennt; sonst ist das ein Fehler.',
    f.upcoming.length ? `Angekündigt: ${f.upcoming.slice(0, 2).map(releaseLabel).join(', ')}.` : '',
    opts.exempt ? 'Diese Aufgabe nennt ein älteres Release ausdrücklich, hier ist es erlaubt.' : '',
  ].filter(Boolean).join('\n')
}

export type StrategyStale = { reason: 'old', hit: ReleaseHit } | { reason: 'before' }

export function strategyStale(texts: (string | null | undefined)[], f: ReleaseFocus | null, decidedDay: string | null): StrategyStale | null {
  if (!f) return null
  const text = texts.filter(Boolean).join('\n')
  if (mentionsCurrent(text, f)) return null
  const hit = oldReleaseHits(text, f)[0]
  if (hit) return { reason: 'old', hit }
  if (decidedDay && decidedDay < f.current.releaseDate) return { reason: 'before' }
  return null
}
