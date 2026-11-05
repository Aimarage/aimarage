import { and, eq, inArray, sql } from 'drizzle-orm'
import { addDays } from '~~/shared/utils/dates'
import { canSeeProject, projectAccess } from '~~/server/lib/access'
import { now, today } from '~~/server/lib/clock'
import { config } from '~~/server/lib/config'
import { getDb, schema } from '~~/server/lib/db'
import { buildIcal } from '~~/server/lib/ical'

export default defineEventHandler(async (event) => {
  const token = (getRouterParam(event, 'file') ?? '').replace(/\.ics$/, '')
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [row] = await db.select({ user: schema.users, ws: schema.workspaces, role: schema.memberships.role }).from(schema.users)
    .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.users.calendarToken, token)).orderBy(schema.memberships.createdAt).limit(1)
  if (!row) throw createError({ statusCode: 404 })
  const d = today(row.ws.timezone)
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, row.ws.id))
  const tasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.workspaceId, row.ws.id), sql`${schema.tasks.dueDate} between ${addDays(d, -30)} and ${addDays(d, 120)}`, inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben', 'wartet', 'erledigt', 'ausgewertet'])))
  const origin = config.appUrl
  const access = await projectAccess(db, { workspaceId: row.ws.id, userId: row.user.id, role: row.role })
  const pmap = new Map(projects.map(p => [p.id, p]))
  setResponseHeader(event, 'Content-Type', 'text/calendar; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return buildIcal(`Aimarage - ${row.ws.name}`, row.ws.timezone, tasks.filter(t => canSeeProject(access, t.projectId)).map(t => ({
    id: t.id,
    code: t.code,
    title: t.title,
    dueDate: t.dueDate!,
    dueTime: t.dueTime,
    durationMin: t.durationMin,
    status: t.status,
    project: t.projectId ? pmap.get(t.projectId)?.name ?? null : null,
    url: `${origin}/p/${t.projectId ? pmap.get(t.projectId)?.slug ?? 'alle' : 'alle'}/aufgaben/${t.id}`,
  })), now())
})
