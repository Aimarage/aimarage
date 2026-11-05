// Rechte eines API/MCP-Schlüssels. read ist immer dabei, alles andere wird je Schlüssel eingestellt.
export const API_PERMS = ['read', 'private', 'draft', 'strategy', 'agent', 'approve'] as const
export type ApiPerm = typeof API_PERMS[number]

export const WRITE_PERMS: readonly ApiPerm[] = ['draft', 'strategy', 'agent', 'approve']

export const TOKEN_DAYS = [30, 90, 180, 365] as const
export const TOKEN_DAYS_DEFAULT = 90
export const TOKEN_WARN_DAYS = 14

export function cleanPerms(v: unknown): ApiPerm[] {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const set = new Set<ApiPerm>(['read'])
  for (const p of API_PERMS) if (list.includes(p)) set.add(p)
  if (set.has('approve')) set.add('draft')
  return API_PERMS.filter(p => set.has(p))
}

// Rechte bestehender Schlüssel vor den einstellbaren Rechten: nur lesen bzw. lesen und ändern, optional freigeben.
export function legacyPerms(scope: string, canApprove = false): ApiPerm[] {
  if (scope !== 'write') return ['read', 'private']
  return cleanPerms(['read', 'private', 'draft', 'strategy', 'agent', ...(canApprove ? ['approve'] : [])])
}

export function scopeOfPerms(perms: readonly ApiPerm[]): 'read' | 'write' {
  return perms.some(p => WRITE_PERMS.includes(p)) ? 'write' : 'read'
}

export function hasPerm(perms: readonly ApiPerm[] | null | undefined, p: ApiPerm): boolean {
  return !perms || perms.includes(p)
}

export function daysLeft(expiresAt: string | Date | null | undefined, at = new Date()): number | null {
  if (!expiresAt) return null
  return Math.ceil((new Date(expiresAt).getTime() - at.getTime()) / 86_400_000)
}
