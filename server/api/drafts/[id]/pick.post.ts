import { and, desc, eq, inArray } from 'drizzle-orm'
import { logActivity } from '~~/server/lib/activity'
import { rememberTone } from '~~/server/lib/conversation'
import { getDb, schema } from '~~/server/lib/db'
import { isConversationTask } from '~~/shared/utils/listening'

// Mitreden: andere Fassung wählen. Die gewählte wird zur neuen Version, die bisherige rückt in die anderen Fassungen; die Wahl ist eine Lehre.
const body = z.object({ key: z.string().regex(/^alt-\d$/) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, row.task.projectId, 'Entwurf nicht gefunden')
  const input = await parseBody(event, body)
  if (!isConversationTask(row.task)) throw createError({ statusCode: 400, statusMessage: 'Nur bei Mitreden-Vorschlägen' })
  if (row.draft.status !== 'offen') throw createError({ statusCode: 409, statusMessage: `Entwurf ist ${row.draft.status}` })
  const chosen = row.draft.variants?.[input.key]?.trim()
  if (!chosen) throw createError({ statusCode: 400, statusMessage: 'Fassung nicht gefunden' })
  const variants = { ...row.draft.variants, [input.key]: row.draft.body }
  const newId = await db.transaction(async (tx) => {
    const [last] = await tx.select({ version: schema.drafts.version }).from(schema.drafts).where(eq(schema.drafts.taskId, row.task.id)).orderBy(desc(schema.drafts.version)).limit(1)
    await tx.update(schema.drafts).set({ status: 'ersetzt' }).where(and(eq(schema.drafts.taskId, row.task.id), inArray(schema.drafts.status, ['offen', 'freigegeben'])))
    const [d] = await tx.insert(schema.drafts).values({
      taskId: row.task.id,
      version: (last?.version ?? 0) + 1,
      kind: row.draft.kind,
      subject: row.draft.subject,
      recipient: row.draft.recipient,
      targetUrl: row.draft.targetUrl,
      body: chosen,
      variant: row.draft.variant,
      platforms: row.draft.platforms,
      variants,
      media: row.draft.media,
      byAgent: true,
      aiGenerated: row.draft.aiGenerated,
      createdByUserId: s.user.id,
    }).returning()
    if (row.task.projectId) await rememberTone(tx, row.task.projectId, { picked: { chosen, others: Object.values(variants) } })
    await logActivity(tx, { workspaceId: s.workspace.id, projectId: row.task.projectId, taskId: row.task.id, actor: 'user', userId: s.user.id, action: 'draft_edited', detail: { title: row.task.title, version: d!.version } })
    return d!.id
  })
  return { id: newId }
})
