import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb, schema } from '~~/server/lib/db'
import { now } from '~~/server/lib/clock'
import { mailDoneStates } from '~~/server/lib/inbox'

const query = z.object({ project: z.string().max(60).optional(), days: z.coerce.number().int().min(1).max(60).optional() })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  if (!roleAtLeast(s.role, 'admin')) throw createError({ statusCode: 403 })
  const q = parseQuery(event, query)
  const db = await getDb()
  const project = await resolveProject(db, s, q.project)
  const projects = (await db.select({ id: schema.projects.id, name: schema.projects.name, slug: schema.projects.slug, setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.workspaceId, s.workspace.id), project ? eq(schema.projects.id, project.id) : undefined))).filter(p => p.setup?.mail)
  if (!projects.length) return { mailboxes: 0, items: [] }
  const since = new Date(now().getTime() - (q.days ?? 14) * 86_400_000)
  const rows = await db.select().from(schema.mails).where(and(
    eq(schema.mails.workspaceId, s.workspace.id),
    eq(schema.mails.direction, 'in'),
    isNotNull(schema.mails.messageId),
    inArray(schema.mails.projectId, projects.map(p => p.id)),
    gte(schema.mails.createdAt, since),
  )).orderBy(desc(schema.mails.createdAt)).limit(300)
  const names = new Map(projects.map(p => [p.id, p.name]))
  const done = await mailDoneStates(db, rows)
  return {
    mailboxes: projects.length,
    items: rows.map(r => ({ id: r.id, project: names.get(r.projectId!) ?? null, from: r.fromAddr, fromName: r.fromName, subject: r.subject, category: r.category, by: r.categoryBy, note: r.note, at: (r.sentAt ?? r.createdAt).toISOString(), taskId: r.taskId, done: done.get(r.id) ?? null })),
  }
})
