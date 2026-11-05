import { eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { activeStrategy } from '~~/server/lib/strategy'
import { assertFullAccess } from '~~/server/lib/preview'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  assertFullAccess(s.workspace)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [row] = await db.select({ st: schema.strategies, p: schema.projects }).from(schema.strategies).innerJoin(schema.projects, eq(schema.projects.id, schema.strategies.projectId)).where(eq(schema.strategies.id, id))
  if (!row || row.st.workspaceId !== s.workspace.id) throw createError({ statusCode: 404, statusMessage: 'Strategie nicht gefunden' })
  await assertProjectVisible(db, s, row.p.id, 'Strategie nicht gefunden')
  const goals = await db.select({ id: schema.goals.id, label: schema.goals.label, targetValue: schema.goals.targetValue, deadline: schema.goals.deadline }).from(schema.goals).where(eq(schema.goals.projectId, row.p.id))
  const cur = await activeStrategy(db, row.p.id)
  return {
    strategy: { id: row.st.id, version: row.st.version, status: row.st.status, kind: row.st.kind, summary: row.st.summary, channels: row.st.channels, changes: row.st.changes, byAgent: row.st.byAgent, createdAt: row.st.createdAt.toISOString() },
    current: cur && cur.id !== row.st.id ? cur.channels : null,
    project: { id: row.p.id, slug: row.p.slug, name: row.p.name, setupState: row.p.setup?.state ?? 'ready', analysis: row.p.setup?.analysis ?? null },
    goals,
  }
})
