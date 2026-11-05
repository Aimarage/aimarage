import { eq } from 'drizzle-orm'
import { today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { finishOnboarding } from '~~/server/lib/onboarding'
import { approveProposal, rejectProposal } from '~~/server/lib/strategy'
import { assertFullAccess } from '~~/server/lib/preview'

const body = z.object({ action: z.enum(['approve', 'reject']) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  assertFullAccess(s.workspace)
  const input = await parseBody(event, body)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [st] = await db.select().from(schema.strategies).where(eq(schema.strategies.id, id))
  if (!st || st.workspaceId !== s.workspace.id) throw createError({ statusCode: 404, statusMessage: 'Strategie nicht gefunden' })
  await assertProjectVisible(db, s, st.projectId, 'Strategie nicht gefunden')
  if (st.status !== 'vorschlag') throw createError({ statusCode: 409, statusMessage: 'Vorschlag ist schon entschieden' })
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, st.projectId))
  if (input.action === 'reject') {
    await rejectProposal(db, project!, st, s.user.id)
    return { ok: true, created: 0, slug: project!.slug }
  }
  if (project!.setup?.state === 'onboarding') {
    const r = await finishOnboarding(db, s.workspace, project!, s.user.id)
    await db.update(schema.conversations).set({ kind: 'project' }).where(eq(schema.conversations.projectId, project!.id))
    return { ok: true, created: r?.created ?? 0, slug: project!.slug }
  }
  const created = await approveProposal(db, project!, st, today(s.workspace.timezone), s.user.id)
  return { ok: true, created, slug: project!.slug }
})
