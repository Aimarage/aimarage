import { and, eq } from 'drizzle-orm'
import { logActivity } from '~~/server/lib/activity'
import { now } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { TRUST_KINDS } from '~~/server/lib/trust'
import { FIXED_APPROVAL } from '~~/shared/utils/plan'

const body = z.object({
  kind: z.enum(TRUST_KINDS),
  accept: z.boolean(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  if (input.accept && FIXED_APPROVAL.includes(input.kind)) throw createError({ statusCode: 400, statusMessage: 'Diese Art gibt immer der Mensch frei' })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404 })
  const asked = { ...p.setup?.trustAsked, [input.kind]: now().toISOString() }
  await db.update(schema.projects).set({
    setup: { ...p.setup, trustAsked: asked },
    ...(input.accept ? { autonomy: { ...p.autonomy, [input.kind]: 'auto_report' as const } } : {}),
  }).where(eq(schema.projects.id, p.id))
  if (input.accept) await logActivity(db, { workspaceId: s.workspace.id, projectId: p.id, actor: 'user', userId: s.user.id, action: 'autonomy_changed', detail: { title: input.kind, level: 'auto_report' }, at: now() })
  return { ok: true }
})
