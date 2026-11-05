import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { enqueueJob } from '~~/server/lib/jobs'

// Startet die Analyse eines Projekts, das mit defer angelegt wurde (erst Unterlagen hochladen, dann analysieren).
export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  if ((p.setup?.state ?? 'ready') !== 'onboarding' || p.setup?.progress) return { ok: true }
  await enqueueJob(db, 'onboard_project', { workspaceId: s.workspace.id, payload: { projectId: p.id, ...(s.workspace.pausedAt ? { preview: true } : {}) }, dedupeKey: `onboard:${p.id}`, maxAttempts: 1 })
  return { ok: true }
})
