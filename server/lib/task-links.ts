import { and, eq, isNull } from 'drizzle-orm'
import type { DbOrTx } from './db'
import { schema } from './db'
import { now } from './clock'

type LinkTask = Pick<typeof schema.tasks.$inferSelect, 'id' | 'workspaceId' | 'projectId'>

export async function addTaskLinks(db: DbOrTx, task: LinkTask, links: { platform?: string | null, url: string | null | undefined }[], at: Date = now()): Promise<void> {
  const rows = links.filter(l => l.url).map(l => ({ workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, platform: l.platform ?? null, url: l.url!, postedAt: at }))
  if (rows.length) await db.insert(schema.taskLinks).values(rows).onConflictDoNothing()
}

export async function dropManualLink(db: DbOrTx, taskId: string, url: string): Promise<void> {
  await db.delete(schema.taskLinks).where(and(eq(schema.taskLinks.taskId, taskId), eq(schema.taskLinks.url, url), isNull(schema.taskLinks.platform)))
}

export async function linksOf(db: DbOrTx, task: Pick<typeof schema.tasks.$inferSelect, 'id' | 'postedUrl' | 'doneAt' | 'updatedAt'>): Promise<{ platform: string | null, url: string, postedAt: string }[]> {
  const rows = await db.select().from(schema.taskLinks).where(eq(schema.taskLinks.taskId, task.id)).orderBy(schema.taskLinks.postedAt, schema.taskLinks.createdAt)
  const out = rows.map(r => ({ platform: r.platform, url: r.url, postedAt: r.postedAt.toISOString() }))
  if (task.postedUrl && !out.some(l => l.url === task.postedUrl)) out.push({ platform: null, url: task.postedUrl, postedAt: (task.doneAt ?? task.updatedAt).toISOString() })
  return out
}
