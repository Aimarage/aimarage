import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { enqueueJob } from '~~/server/lib/jobs'
import { afterHostedConnect, verifySignature, workspaceByProfile } from '~~/server/lib/zernio'

// Webhook von Zernio (gehostet): Konten verbunden oder getrennt, Beitrag fertig. Signiert mit ZERNIO_WEBHOOK_SECRET.
export default defineEventHandler(async (event) => {
  const raw = (await readRawBody(event, 'utf8')) ?? ''
  if (!verifySignature(raw, getHeader(event, 'x-zernio-signature'))) throw createError({ statusCode: 401, statusMessage: 'Signatur ungültig' })
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Kein JSON' })
  }
  const kind = String(body.event ?? '')
  const db = await getDb()
  const account = (body.account ?? {}) as Record<string, unknown>
  const profiles = Array.isArray(body.profiles) ? body.profiles as Record<string, unknown>[] : []
  const profileId = String(account.profileId ?? profiles[0]?.id ?? '')
  if ((kind === 'account.connected' || kind === 'account.disconnected') && profileId) {
    const ws = await workspaceByProfile(db, profileId)
    if (ws) await afterHostedConnect(db, ws.id)
    return { ok: true }
  }
  if (kind.startsWith('post.') && body.post && typeof body.post === 'object') {
    const postId = String((body.post as Record<string, unknown>).id ?? (body.post as Record<string, unknown>)._id ?? '')
    if (postId) {
      const [row] = await db.select({ id: schema.socialPosts.id, taskId: schema.socialPosts.taskId, workspaceId: schema.socialPosts.workspaceId, checks: schema.socialPosts.checks }).from(schema.socialPosts)
        .where(and(eq(schema.socialPosts.requestId, postId), eq(schema.socialPosts.status, 'laeuft'))).limit(1)
      if (row) await enqueueJob(db, 'publish_status', { workspaceId: row.workspaceId, payload: { postId: row.id, taskId: row.taskId }, dedupeKey: `publish_status:${row.id}:hook:${String(body.id ?? kind)}`, maxAttempts: 3 })
    }
  }
  return { ok: true }
})
