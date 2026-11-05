import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { listConnections } from '~~/server/lib/connections'
import { assertAccountLimit, assertPlatformFree } from '~~/server/lib/limits'

const body = z.object({ id: z.string().trim().min(1).max(200) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const input = await parseBody(event, body)
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  const known = listConnections(s.workspace).some(c => c.id === input.id) || (s.workspace.settings?.social?.accounts ?? []).some(a => a.id === input.id)
  if (!known) throw createError({ statusCode: 404, statusMessage: 'Konto nicht gefunden' })
  await assertAccountLimit(db, s.workspace, 0)
  const social = p.setup?.social ?? {}
  const ids = new Set(social.accountIds ?? [])
  ids.add(input.id)
  assertPlatformFree(s.workspace, social, { ...social, accountIds: [...ids] })
  await db.update(schema.projects).set({ setup: { ...p.setup, social: { ...social, accountIds: [...ids] } } }).where(eq(schema.projects.id, p.id))
  return { ok: true }
})
