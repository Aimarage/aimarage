import { isPlatformBlocked } from '../../shared/utils/blocked-platforms'
import { parseListenOrigin } from '../../shared/utils/listening'
import { listConnections } from './connections'
import type { schema } from './db'
import type { SocialConn } from './platforms/types'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export function projectConns(ws: Workspace, project: Pick<Project, 'setup'> | null, platform: 'bluesky' | 'mastodon'): SocialConn[] {
  if (!project || isPlatformBlocked(project, platform)) return []
  const ids = new Set(project.setup?.social?.accountIds ?? [])
  return listConnections(ws).filter(c => ids.has(c.id) && c.platform === platform)
}

export interface ReplyAccount {
  platform: 'bluesky' | 'mastodon'
  handle: string | null
  connected: boolean
}

// Listening-Antwort auf Bluesky/Mastodon: Aimarage antwortet nach der Freigabe selbst über dieses Konto. Reddit und andere Aufgaben: null.
export function replyAccount(ws: Workspace, project: Pick<Project, 'setup'> | null, task: { origin: string | null }): ReplyAccount | null {
  const o = parseListenOrigin(task.origin)
  if (!o || (o.platform !== 'bluesky' && o.platform !== 'mastodon')) return null
  const conn = projectConns(ws, project, o.platform)[0]
  const raw = conn ? (conn.handle?.trim() || conn.name?.trim() || null) : null
  const handle = raw && !raw.startsWith('@') && !/\s/.test(raw) ? `@${raw}` : raw
  return { platform: o.platform, handle, connected: !!conn }
}
