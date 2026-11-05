import { eq, and } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { listConnections, upsertConnection } from '~~/server/lib/connections'
import { assertAccountLimit, assertSocialAccountLimit, platformKey, platformTaken } from '~~/server/lib/limits'
import { verifyBluesky } from '~~/server/lib/platforms/bluesky'
import { verifyMastodon } from '~~/server/lib/platforms/mastodon'
import { verifyTelegram } from '~~/server/lib/platforms/telegram'
import { PlatformError } from '~~/server/lib/platforms/types'
import { verifyX } from '~~/server/lib/platforms/x'

const s200 = z.string().trim().min(1).max(500)
const body = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('bluesky'), identifier: s200, password: s200, url: z.string().trim().max(200).optional(), projectId: z.string().uuid().nullable().optional() }),
  z.object({ provider: z.literal('mastodon'), url: s200, token: s200, projectId: z.string().uuid().nullable().optional() }),
  z.object({ provider: z.literal('x'), consumerKey: s200, consumerSecret: s200, token: s200, tokenSecret: s200, projectId: z.string().uuid().nullable().optional() }),
  z.object({ provider: z.literal('telegram'), token: s200, chat: s200, projectId: z.string().uuid().nullable().optional() }),
])

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const db = await getDb()
  let projectSocial: { profileIds?: string[], accountIds?: string[] } | null = null
  if (input.projectId) {
    const [p] = await db.select({ id: schema.projects.id, setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.id, input.projectId), eq(schema.projects.workspaceId, s.workspace.id)))
    if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
    projectSocial = p.setup?.social ?? {}
  }
  try {
    const v = input.provider === 'bluesky'
      ? await verifyBluesky(input, fetch)
      : input.provider === 'mastodon'
        ? await verifyMastodon(input, fetch)
        : input.provider === 'telegram' ? await verifyTelegram(input, fetch) : await verifyX(input, fetch)
    const same = listConnections(s.workspace).find(c => c.provider === v.conn.provider && c.platform === v.conn.platform && (c.handle ?? c.name) === (v.conn.handle ?? v.conn.name))
    const known = !!same
    if (projectSocial && platformTaken(s.workspace, projectSocial, v.conn.platform, same?.id ?? null)) {
      throw createError({ statusCode: 409, statusMessage: `Dieses Projekt hat schon ein Konto für ${platformKey(v.conn.platform)}. Je Projekt geht ein Konto pro Plattform.`, data: { code: 'one_per_platform', platform: platformKey(v.conn.platform) } })
    }
    await assertAccountLimit(db, s.workspace, known ? 0 : 1)
    await assertSocialAccountLimit(db, s.workspace, known ? 0 : 1)
    const conn = await upsertConnection(db, s.workspace.id, v.conn, v.creds, { projectId: input.projectId ?? null })
    return { ok: true, id: conn.id, name: conn.name }
  }
  catch (err) {
    if (err instanceof PlatformError) return { ok: false, error: err.message }
    throw err
  }
})
