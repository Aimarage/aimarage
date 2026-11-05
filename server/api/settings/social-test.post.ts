import { eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { listSocialAccounts, socialConfig, socialEnvAllowed } from '~~/server/lib/social'

const body = z.object({
  provider: z.enum(['uploadpost', 'zernio']).optional(),
  apiKey: z.string().trim().max(512).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const saved = s.workspace.settings?.social
  const provider = input.provider ?? saved?.provider ?? 'uploadpost'
  const cfg = socialConfig({ ...saved, provider, ...(provider !== (saved?.provider ?? 'uploadpost') ? { key: undefined } : {}) }, s.workspace.id, undefined, socialEnvAllowed(s.workspace.settings))
  const res = await listSocialAccounts(input.apiKey ? { ...cfg, apiKey: input.apiKey, keySource: 'workspace' } : cfg)
  if (res.ok && (provider === (saved?.provider ?? 'uploadpost') || cfg.keySource === 'hosted')) {
    const db = await getDb()
    const [cur] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, s.workspace.id))
    await db.update(schema.workspaces).set({ settings: { ...cur!.settings, social: { ...cur!.settings.social, accounts: res.accounts, profiles: res.profiles, checkedAt: new Date().toISOString() } } }).where(eq(schema.workspaces.id, s.workspace.id))
  }
  return res
})
