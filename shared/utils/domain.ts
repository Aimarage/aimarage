export const CATEGORIES = ['content', 'community', 'outreach', 'verzeichnis', 'social', 'launch', 'messen', 'pflege', 'bericht'] as const
export type Category = typeof CATEGORIES[number]

export const CATEGORY_CODES: Record<Category, string> = {
  content: 'CON',
  community: 'COM',
  outreach: 'OUT',
  verzeichnis: 'DIR',
  social: 'SOC',
  launch: 'LAU',
  messen: 'MES',
  pflege: 'PFL',
  bericht: 'REP',
}

export const CATEGORY_COLOR_VAR: Record<Category, string> = {
  content: '--t-con',
  community: '--t-com',
  outreach: '--t-out',
  verzeichnis: '--t-dir',
  social: '--t-soc',
  launch: '--t-lau',
  messen: '--t-all',
  pflege: '--t-all',
  bericht: '--t-rep',
}

export const STATUSES = ['geplant', 'entwurf_fertig', 'freigegeben', 'wartet', 'erledigt', 'ausgewertet', 'verworfen'] as const
export type TaskStatus = typeof STATUSES[number]

export const OPEN_STATUSES: TaskStatus[] = ['geplant', 'entwurf_fertig', 'freigegeben', 'wartet']
export const DONE_STATUSES: TaskStatus[] = ['erledigt', 'ausgewertet']

export const STATUS_FLOW: Record<TaskStatus, TaskStatus[]> = {
  geplant: ['entwurf_fertig', 'freigegeben', 'wartet', 'erledigt', 'verworfen'],
  entwurf_fertig: ['freigegeben', 'geplant', 'wartet', 'erledigt', 'verworfen'],
  freigegeben: ['erledigt', 'wartet', 'entwurf_fertig', 'geplant', 'verworfen'],
  wartet: ['erledigt', 'freigegeben', 'geplant', 'verworfen'],
  erledigt: ['ausgewertet', 'wartet', 'freigegeben', 'verworfen'],
  ausgewertet: ['erledigt', 'verworfen'],
  verworfen: ['geplant'],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || STATUS_FLOW[from].includes(to)
}

export const PRIOS = ['P1', 'P2', 'P3'] as const
export type Prio = typeof PRIOS[number]

export const DRAFT_KINDS = ['post', 'mail', 'article', 'text'] as const
export type DraftKind = typeof DRAFT_KINDS[number]

export const DRAFT_STATUSES = ['offen', 'freigegeben', 'verworfen', 'ersetzt'] as const
export type DraftStatus = typeof DRAFT_STATUSES[number]

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type Role = typeof ROLES[number]

export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

export const CHANNEL_STATUSES = ['offen', 'eingereicht', 'live', 'abgelehnt'] as const
export type ChannelStatus = typeof CHANNEL_STATUSES[number]

export const PROJECT_COLORS = ['teal', 'amber', 'pink', 'blue', 'violet', 'green', 'red', 'slate'] as const
export type ProjectColor = typeof PROJECT_COLORS[number]

export const CAL_VIEWS = ['day', 'week', 'month'] as const
export type CalView = typeof CAL_VIEWS[number]

export interface Kpi {
  key: string
  label: string
}

export const DEFAULT_KPIS: Kpi[] = [
  { key: 'visitors', label: 'Besucher' },
  { key: 'signups', label: 'Anmeldungen' },
  { key: 'sales', label: 'Verkäufe' },
]

export const ALL_SLUG = 'alle'

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase()
  return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase()
}

export function monogram(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim()
  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase()
  const w = parts[0] ?? '?'
  return (w.slice(0, 1) + (w.slice(1).match(/[bcdfghjklmnpqrstvwxyz]/i)?.[0] ?? w.slice(1, 2))).toUpperCase()
}

export function slugify(name: string): string {
  return name.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'projekt'
}
