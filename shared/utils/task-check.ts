import { platformOf, taskType } from './drafting'
import { OPEN_STATUSES, type TaskStatus } from './domain'

export type CheckKind = 'seo' | 'seo-drop' | 'directory' | 'post'

export interface CheckItem {
  text: string
  done: boolean
}

export const SEO_CHECK_GROUPS = ['links', 'noindex', 'title', 'desc', 'h1', 'hreflang', 'h1multi', 'img', 'thin', 'canonical'] as const
export type SeoCheckGroup = typeof SEO_CHECK_GROUPS[number]

const LEGACY: Record<string, SeoCheckGroup> = {
  http_error: 'links',
  noindex: 'noindex',
  title_missing: 'title',
  title_long: 'title',
  title_duplicate: 'title',
  desc_missing: 'desc',
  desc_long: 'desc',
  h1_missing: 'h1',
  hreflang_missing: 'hreflang',
}

export function seoGroupOf(origin: string | null | undefined): SeoCheckGroup | null {
  if (!origin) return null
  if (origin.startsWith('seo-group:')) {
    const g = origin.slice(10)
    return (SEO_CHECK_GROUPS as readonly string[]).includes(g) ? g as SeoCheckGroup : null
  }
  if (origin.startsWith('seo:')) return LEGACY[origin.split(':')[1] ?? ''] ?? null
  return null
}

export interface CheckShape {
  title: string
  category: string
  origin?: string | null
  channel?: string | null
  draftKind?: string | null
  targetUrl?: string | null
  description?: string | null
}

// Aufgaben, die Aimarage selbst nachprüfen kann; alle anderen werden einfach als erledigt markiert.
export function checkKind(t: CheckShape): CheckKind | null {
  if (seoGroupOf(t.origin)) return 'seo'
  if (t.origin?.startsWith('seo-drop:')) return 'seo-drop'
  if (t.draftKind === 'mail') return null
  const type = taskType(t)
  if (type === 'research') return null
  if (t.category === 'verzeichnis') return 'directory'
  if (t.category === 'community' || (t.category === 'social' && platformOf(t) === 'reddit')) return type === 'post' || type === 'reply' ? 'post' : null
  return null
}

export function openFirst(items: CheckItem[]): CheckItem[] {
  return [...items.filter(i => !i.done), ...items.filter(i => i.done)]
}

export function isOpenStatus(s: TaskStatus): boolean {
  return OPEN_STATUSES.includes(s)
}
