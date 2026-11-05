import { autonomyKindOf, FIXED_APPROVAL, type AutonomyKindT } from '../../shared/utils/plan'
import type { AutonomyLevel, PostPlatformResult } from '../db/schema'
import type { SocialConfig, SocialProvider } from './social'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface OutletMedia {
  name: string
  mime: string
  data: Uint8Array
  url?: string | null
}

export interface PostRequest {
  profile: string
  platforms: string[]
  text: string
  variants: Record<string, string>
  media: OutletMedia[]
  at: Date | null
  timezone: string
  externalId: string
  // Konto je Plattform (Zernio postet je Konto, nicht je Profil)
  accounts?: Record<string, string>
  // Text von der KI erzeugt: Plattform-Kennzeichnung setzen, wo es ein Feld dafür gibt (Art. 50 Abs. 2 KI-VO)
  aiGenerated?: boolean
}

export interface PostOutcome {
  state: 'done' | 'pending' | 'scheduled' | 'failed'
  requestId: string | null
  results: PostPlatformResult[]
  error: string | null
}

export interface PostStat {
  platform: string
  url: string | null
  metrics: Record<string, number>
}

export interface SocialOutlet {
  id: SocialProvider
  label: string
  post: (cfg: SocialConfig, req: PostRequest, fetchImpl?: FetchLike) => Promise<PostOutcome>
  status: (cfg: SocialConfig, requestId: string, fetchImpl?: FetchLike) => Promise<PostOutcome>
  stats: (cfg: SocialConfig, requestId: string, fetchImpl?: FetchLike) => Promise<PostStat[]>
  profileStats: (cfg: SocialConfig, profile: string, platforms: string[], fetchImpl?: FetchLike) => Promise<Record<string, Record<string, number>>>
}

const registry = new Map<string, SocialOutlet>()

export function registerOutlet(o: SocialOutlet): void {
  registry.set(o.id, o)
}

export function socialOutlet(provider: string): SocialOutlet | null {
  return registry.get(provider) ?? null
}

export function listOutlets(): { id: string, label: string }[] {
  return [...registry.values()].map(o => ({ id: o.id, label: o.label }))
}

export function effectiveAutonomy(autonomy: Partial<Record<AutonomyKindT, AutonomyLevel>>, category: string, draftKind: string | null): { kind: AutonomyKindT | null, level: AutonomyLevel, fixed: boolean } {
  const kind = autonomyKindOf(category, draftKind)
  if (!kind) return { kind, level: 'approve', fixed: false }
  if (FIXED_APPROVAL.includes(kind)) return { kind, level: 'approve', fixed: true }
  return { kind, level: autonomy[kind] ?? 'approve', fixed: false }
}

export type PublishDecision = { action: 'approve', reason: 'level' | 'fixed' | 'no_outlet' } | { action: 'publish', report: boolean }

export function canPublishTask(task: { category: string, draftKind: string | null }): boolean {
  return task.category === 'social' && (task.draftKind === 'post' || task.draftKind === null || task.draftKind === 'text')
}

export function decideArticle(project: { autonomy?: Partial<Record<AutonomyKindT, AutonomyLevel>> | null, setup?: { blogApi?: { secret?: unknown } | null } | null }): PublishDecision {
  const a = effectiveAutonomy(project.autonomy ?? {}, 'content', 'article')
  if (a.level === 'approve') return { action: 'approve', reason: 'level' }
  if (!project.setup?.blogApi?.secret) return { action: 'approve', reason: 'no_outlet' }
  return { action: 'publish', report: a.level === 'auto_report' }
}

export function decidePublish(autonomy: Partial<Record<AutonomyKindT, AutonomyLevel>>, task: { category: string, draftKind: string | null, channel: string | null }, outletReady = false): PublishDecision {
  const a = effectiveAutonomy(autonomy, task.category, task.draftKind)
  if (a.fixed) return { action: 'approve', reason: 'fixed' }
  if (a.level === 'approve') return { action: 'approve', reason: 'level' }
  if (!outletReady || !canPublishTask(task)) return { action: 'approve', reason: 'no_outlet' }
  return { action: 'publish', report: a.level === 'auto_report' }
}
