import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { readProgress } from '~~/server/lib/onboarding'
import { previewOnly, TEASER_CHANNELS, teaserFrom } from '~~/server/lib/preview'
import { pendingProposal } from '~~/server/lib/strategy'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  await assertProjectVisible(db, s, p.id, 'Projekt nicht gefunden')
  const pending = await pendingProposal(db, p.id)
  const project = { id: p.id, slug: p.slug, name: p.name, state: p.setup?.state ?? 'ready' }
  // Vorschau ohne Tarif: nur der Teaser, die volle Strategie bleibt bis zur Testphase verborgen.
  if (previewOnly(s.workspace)) {
    const teaser = pending ? teaserFrom({ summary: pending.summary ?? '', positioning: p.setup?.analysis?.positioning ?? null, channels: pending.channels, posts: p.setup?.preview?.posts }) : null
    return { project, progress: readProgress(p.setup), proposalId: null, teaser, hidden: pending ? Math.max(0, pending.channels.length - TEASER_CHANNELS) : 0 }
  }
  return { project, progress: readProgress(p.setup), proposalId: pending?.id ?? null }
})
