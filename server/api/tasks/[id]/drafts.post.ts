import { and, desc, eq, inArray } from 'drizzle-orm'
import { DRAFT_KINDS } from '~~/shared/utils/domain'
import { logActivity } from '~~/server/lib/activity'
import { getDb, schema } from '~~/server/lib/db'
import { withUtm } from '~~/server/lib/publish'
import { aiAfterEdit } from '~~/shared/utils/ai-label'

const body = z.object({
  kind: z.enum(DRAFT_KINDS),
  subject: z.string().max(300).nullable().optional(),
  recipient: z.string().max(300).nullable().optional(),
  targetUrl: httpUrl(1000).nullable().optional().or(z.literal('').transform(() => null)),
  body: z.string().trim().min(1).max(50_000),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  const { body: text } = await withUtm(db, t, { body: input.body })
  const id = await db.transaction(async (tx) => {
    const [prev] = await tx.select({ version: schema.drafts.version, body: schema.drafts.body, aiGenerated: schema.drafts.aiGenerated }).from(schema.drafts).where(eq(schema.drafts.taskId, t.id)).orderBy(desc(schema.drafts.version)).limit(1)
    await tx.update(schema.drafts).set({ status: 'ersetzt' }).where(and(eq(schema.drafts.taskId, t.id), inArray(schema.drafts.status, ['offen', 'freigegeben'])))
    const [d] = await tx.insert(schema.drafts).values({ ...input, body: text, taskId: t.id, version: (prev?.version ?? 0) + 1, aiGenerated: aiAfterEdit(prev, text), createdByUserId: s.user.id }).returning()
    if (t.status === 'geplant') await tx.update(schema.tasks).set({ status: 'entwurf_fertig' }).where(eq(schema.tasks.id, t.id))
    await logActivity(tx, { workspaceId: s.workspace.id, projectId: t.projectId, taskId: t.id, actor: 'user', userId: s.user.id, action: 'draft_written', detail: { title: t.title } })
    return d!.id
  })
  return { id }
})
