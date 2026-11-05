import { ORDER_HEAD } from './digest'

export const BUDGET_CHOICES = [5, 15, 30, 60] as const
export const BUDGET_DEFAULT = 15

// Realistischer Aufwand für den Menschen: Freigeben eines Social-Posts 1 Min, einer Mail 4 Min, sonst 5 Min.
export const APPROVE_MIN = { post: 1, mail: 4, other: 5 } as const
// Selbst posten bzw. eintragen nach der Freigabe: Social-Post (z.B. Reddit) 3 Min, Mail 4 Min, Verzeichnis-Eintrag 5 Min.
export const SELF_POST_MIN = { post: 3, mail: 4, directory: 5 } as const
// Alle "Info nötig"-Rückfragen eines Tages zusammen.
export const INFO_BUNDLE_MIN = 5
export const SELF_DEFAULT_MIN = 15

// Aufgaben mit geringer Wirkung (P3), die so weit hinter ihren ersten Termin rutschen, fallen weg.
export const DROP_AFTER_DAYS = 14

export type CostKind = 'self' | 'approve' | 'info' | 'claude' | 'auto' | 'none'

export function budgetOf(settings: { timeBudget?: Record<string, number> } | null | undefined, userId: string | null | undefined): number {
  const n = userId ? settings?.timeBudget?.[userId] : undefined
  return typeof n === 'number' && n >= 1 ? Math.floor(n) : BUDGET_DEFAULT
}

export function approveMinutes(draftKind: string | null | undefined, category: string): number {
  if (draftKind === 'mail') return APPROVE_MIN.mail
  if (draftKind === 'post' || category === 'social' || category === 'community') return APPROVE_MIN.post
  return APPROVE_MIN.other
}

// Website-/Code-Aufgaben erledigt Claude (Code) über MCP, nicht der Mensch.
export function isClaudeTask(t: { category: string, origin: string | null, description: string | null, humanStep: string | null }): boolean {
  if (t.origin?.startsWith('seo-group:') || t.origin?.startsWith('seo-drop:') || t.origin?.startsWith('seo:')) return true
  if (t.description?.includes(ORDER_HEAD)) return true
  return /claude code/i.test(t.humanStep ?? '')
}
