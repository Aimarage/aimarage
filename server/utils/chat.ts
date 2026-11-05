import type { SessionInfo } from '../lib/auth'
import type { ChatActor } from '../lib/chat'
import type { Db } from '../lib/db'

export async function chatActor(db: Db, s: SessionInfo): Promise<ChatActor> {
  return { workspace: s.workspace, userId: s.user.id, userName: s.user.name, locale: s.user.locale, role: s.role, access: await accessOf(db, s) }
}
