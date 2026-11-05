import { hasPlaceholder } from './social'

export const MCP_APPROVE_KINDS = ['content', 'social', 'community', 'verzeichnis', 'mail'] as const
export type McpApproveKind = typeof MCP_APPROVE_KINDS[number]
export const MCP_APPROVE_DEFAULT_KINDS: McpApproveKind[] = ['content', 'social', 'community']
export const MCP_DELAY_DEFAULT = 30
export const MCP_PER_DAY_DEFAULT = 10
export const MCP_MAX_DELAY = 1440
export const MCP_MAX_PER_DAY = 100
export const MCP_MIN_REASON = 40
export const MCP_MAX_LINKS = 20

export interface McpApproveConfig {
  enabled: boolean
  kinds: McpApproveKind[]
  delayMin: number
  perDay: number
  offProjects: string[]
}

const int = (v: unknown, def: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def)

export function mcpApproveConfig(s: { enabled?: boolean, kinds?: string[], delayMin?: number, perDay?: number, offProjects?: string[] } | null | undefined): McpApproveConfig {
  return {
    enabled: s?.enabled === true,
    kinds: Array.isArray(s?.kinds) ? MCP_APPROVE_KINDS.filter(k => s.kinds!.includes(k)) : [...MCP_APPROVE_DEFAULT_KINDS],
    delayMin: int(s?.delayMin, MCP_DELAY_DEFAULT, 0, MCP_MAX_DELAY),
    perDay: int(s?.perDay, MCP_PER_DAY_DEFAULT, 1, MCP_MAX_PER_DAY),
    offProjects: Array.isArray(s?.offProjects) ? s.offProjects.filter(x => typeof x === 'string') : [],
  }
}

export function mcpKindOf(task: { category: string, draftKind: string | null }, draft: { kind: string }): McpApproveKind | null {
  if (draft.kind === 'mail') return task.category === 'outreach' ? null : 'mail'
  if (task.draftKind === 'mail') return null
  return (MCP_APPROVE_KINDS as readonly string[]).includes(task.category) ? task.category as McpApproveKind : null
}

const EXTRA_PLACEHOLDER = /\[\s*\.{2,}\s*\]|\.\.\.\]|\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b|lorem ipsum/i

export function textProblems(texts: (string | null | undefined)[]): string[] {
  const all = texts.filter(Boolean).join('\n')
  const out: string[] = []
  if (/[\u2013\u2014]/.test(all)) out.push('Lange Striche im Text (nur normale Bindestriche)')
  if (hasPlaceholder(all) || EXTRA_PLACEHOLDER.test(all)) out.push('Platzhalter im Text (z.B. [..], TODO)')
  return out
}

export function linksIn(texts: (string | null | undefined)[]): string[] {
  const all = texts.filter(Boolean).join('\n')
  const found = all.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []
  const clean = found.map(u => u.replace(/[).,;:!?\]*_]+$/, '')).filter(u => u.length > 10)
  return [...new Set(clean)]
}
