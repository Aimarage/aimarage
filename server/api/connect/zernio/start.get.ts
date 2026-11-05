import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { config } from '~~/server/lib/config'
import { updateSettings } from '~~/server/lib/connections'
import { getDb, schema } from '~~/server/lib/db'
import { assertSocialAccountLimit, platformTaken } from '~~/server/lib/limits'
import { OutletError } from '~~/server/lib/uploadpost'
import { connectUrl, ensureProfile, hostedConfig, isZernioPlatform } from '~~/server/lib/zernio'

// Gehostet: Konto über Zernio verbinden (kein eigener Schlüssel, keine eigene App). Liefert die Anmelde-Adresse.
const query = z.object({ project: z.string().uuid(), platform: z.string().trim().max(30) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const q = parseQuery(event, query)
  if (!isZernioPlatform(q.platform)) throw createError({ statusCode: 404 })
  const cfg = hostedConfig(s.workspace)
  if (!cfg) throw createError({ statusCode: 400, statusMessage: 'Verbinden über Aimarage ist hier nicht verfügbar' })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, q.project), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  if (platformTaken(s.workspace, p.setup?.social, q.platform)) throw createError({ statusCode: 409, statusMessage: 'Dieses Projekt hat schon ein Konto für diese Plattform. Je Projekt geht ein Konto pro Plattform.', data: { code: 'one_per_platform', platform: q.platform } })
  await assertSocialAccountLimit(db, s.workspace, 1)
  try {
    const profileId = await ensureProfile(db, s.workspace, cfg)
    const state = randomBytes(18).toString('base64url')
    await updateSettings(db, s.workspace.id, x => ({ ...x, oauthStates: [...(x.oauthStates ?? []).filter(o => Date.now() - Date.parse(o.at) < 3_600_000).slice(-9), { state, provider: `zernio:${q.platform}`, projectId: p.id, at: new Date().toISOString() }] }))
    return { url: await connectUrl({ ...cfg, profileId }, profileId, q.platform, `${config.appUrl}/api/connect/zernio/callback?s=${state}`) }
  }
  catch (err) {
    if (err instanceof OutletError) throw createError({ statusCode: 502, statusMessage: err.message })
    throw err
  }
})
