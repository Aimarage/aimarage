const CODE_RE = /^([a-z0-9]{2,10})[\s_-]+([a-z]{3})[\s_-]*(\d{1,5})$/i

export function normalizeTaskCode(raw: string): string | null {
  const m = CODE_RE.exec(raw.trim())
  if (!m) return null
  return `${m[1]!.toUpperCase()}-${m[2]!.toUpperCase()}-${m[3]!.replace(/^0+(?=\d)/, '').padStart(3, '0')}`
}

export interface SearchHit {
  id: string
  label: string
  code: string | null
  to: string
}

export interface SearchResult {
  exact: SearchHit | null
  tasks: SearchHit[]
  drafts: SearchHit[]
  projects: SearchHit[]
}
