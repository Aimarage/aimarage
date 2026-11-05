import { and, desc, eq, inArray } from 'drizzle-orm'
import { logActivity } from '~~/server/lib/activity'
import { getDb, schema } from '~~/server/lib/db'
import { cancelPosts, withUtm } from '~~/server/lib/publish'
import { aiAfterEdit } from '~~/shared/utils/ai-label'

const body = z.object({
  subject: z.string().max(300).nullable().optional(),
  recipient: z.string().max(300).nullable().optional(),
  targetUrl: httpUrl(1000).nullable().optional().or(z.literal('').transform(() => null)),
  body: z.string().trim().min(1).max(50_000),
  platforms: z.array(z.string().max(40)).max(20).optional(),
  variants: z.record(z.string().max(40), z.string().max(50_000)).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const input = await parseBody(event, body)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, row.task.projectId, 'Entwurf nicht gefunden')
  const text = await withUtm(db, row.task, { body: input.body, variants: Object.fromEntries(Object.entries(input.variants ?? row.draft.variants).filter(([, v]) => v.trim())) })
  const newId = await db.transaction(async (tx) => {
    const [last] = await tx.select({ version: schema.drafts.version }).from(schema.drafts).where(eq(schema.drafts.taskId, row.task.id)).orderBy(desc(schema.drafts.version)).limit(1)
    await tx.update(schema.drafts).set({ status: 'ersetzt' }).where(and(eq(schema.drafts.taskId, row.task.id), inArray(schema.drafts.status, ['offen', 'freigegeben'])))
    const [d] = await tx.insert(schema.drafts).values({
      taskId: row.task.id,
      version: (last?.version ?? 0) + 1,
      kind: row.draft.kind,
      subject: input.subject === undefined ? row.draft.subject : input.subject,
      recipient: input.recipient === undefined ? row.draft.recipient : input.recipient,
      targetUrl: input.targetUrl === undefined ? row.draft.targetUrl : input.targetUrl,
      body: text.body,
      variant: row.draft.variant,
      platforms: input.platforms ?? row.draft.platforms,
      variants: text.variants,
      media: row.draft.media,
      aiGenerated: aiAfterEdit(row.draft, text.body),
      createdByUserId: s.user.id,
    }).returning()
    await cancelPosts(tx, row.task.id)
    if (row.task.status === 'geplant' || row.task.status === 'freigegeben') await tx.update(schema.tasks).set({ status: 'entwurf_fertig' }).where(eq(schema.tasks.id, row.task.id))
    await logActivity(tx, { workspaceId: s.workspace.id, projectId: row.task.projectId, taskId: row.task.id, actor: 'user', userId: s.user.id, action: 'draft_edited', detail: { title: row.task.title, version: d!.version } })
    return d!.id
  })
  return { id: newId }
})
