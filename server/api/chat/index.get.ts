import { eq } from 'drizzle-orm'
import { agentReady } from '~~/server/lib/agent'
import { conversationMessages, findConversation, isBusy, QUEUED, runTurn } from '~~/server/lib/chat'
import { getDb, schema } from '~~/server/lib/db'
import { readProgress } from '~~/server/lib/onboarding'

const query = z.object({ project: z.string().max(60).optional(), onboarding: z.string().optional(), id: z.string().uuid().optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const db = await getDb()
  const actor = await chatActor(db, s)
  let conv = null
  if (q.id) {
    const [c] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, q.id))
    if (c && c.workspaceId === s.workspace.id && c.userId === s.user.id) conv = c
  }
  if (!conv) {
    if (q.onboarding) {
      if (!actor.access.all) throw createError({ statusCode: 403, statusMessage: 'Keine Berechtigung' })
      conv = await findConversation(db, actor, null, { onboarding: true, create: true })
    }
    else {
      const project = await resolveProject(db, s, q.project)
      conv = await findConversation(db, actor, project?.id ?? null, { create: true })
    }
  }
  const rows = await conversationMessages(db, conv!.id, 120)
  const toolName = new Map<string, string>()
  for (const m of rows) for (const c of m.toolCalls ?? []) toolName.set(c.id, c.name)
  const [project] = conv!.projectId ? await db.select().from(schema.projects).where(eq(schema.projects.id, conv!.projectId)) : []
  const waiting = rows.filter(m => m.role === QUEUED)
  if (waiting.length && !isBusy(conv!.id)) void runTurn(db, actor, conv!.id).catch(err => console.error('[chat]', err))
  const busy = isBusy(conv!.id) || waiting.length > 0
  return {
    conversation: { id: conv!.id, kind: conv!.kind, title: conv!.title, projectId: conv!.projectId, projectSlug: project?.slug ?? null, setupState: project?.setup?.state ?? null },
    busy,
    ready: agentReady(s.workspace),
    progress: project && busy ? readProgress(project.setup) : null,
    messages: [...rows.filter(m => m.role !== QUEUED), ...waiting].filter(m => m.role !== 'assistant' || m.content || !m.toolCalls?.length).map(m => ({
      id: m.id,
      role: m.role === QUEUED ? 'user' : m.role,
      queued: m.role === QUEUED,
      content: m.role === 'tool' ? '' : m.content,
      tool: m.role === 'tool' ? toolName.get(m.toolCallId ?? '') ?? null : null,
      error: m.role === 'tool' ? /^\{"error"/.test(m.content) : false,
      cards: m.role === 'tool' ? [] : m.cards,
      at: m.createdAt.toISOString(),
    })),
  }
})
