import type { DbOrTx } from './db'
import { schema } from './db'

export interface ActivityInput {
  workspaceId: string
  projectId?: string | null
  taskId?: string | null
  actor: 'user' | 'agent' | 'system' | 'mcp'
  userId?: string | null
  action: string
  detail?: Record<string, unknown>
  at?: Date
}

export async function logActivity(db: DbOrTx, a: ActivityInput): Promise<void> {
  await db.insert(schema.activity).values({
    workspaceId: a.workspaceId,
    projectId: a.projectId ?? null,
    taskId: a.taskId ?? null,
    actor: a.actor,
    userId: a.userId ?? null,
    action: a.action,
    detail: a.detail ?? {},
    ...(a.at ? { createdAt: a.at } : {}),
  })
}

export const CLIENT_ACTIONS = ['client_ok', 'client_change', 'client_approved']
