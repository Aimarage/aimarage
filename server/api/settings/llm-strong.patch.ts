import { getDb } from '~~/server/lib/db'
import { applyStrongUpdate, llmLocked, STRONG_PROVIDERS, type Provider } from '~~/server/lib/llm'
import { updateSettings } from '~~/server/lib/connections'
import { assertStrongModel } from '~~/server/lib/limits'

const body = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(STRONG_PROVIDERS as [Provider, ...Provider[]]).optional(),
  baseUrl: z.string().trim().max(300).refine(v => !v || /^https?:\/\//.test(v), 'Adresse muss mit http:// oder https:// beginnen').optional(),
  model: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().min(8).max(512).regex(/^\S+$/).optional(),
  removeKey: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  if (llmLocked()) throw createError({ statusCode: 403, statusMessage: 'KI-Einstellungen sind vom Betreiber vorgegeben' })
  const input = await parseBody(event, body)
  if (input.enabled) assertStrongModel(s.workspace)
  if (input.baseUrl) await assertLlmBaseUrl(input.baseUrl)
  const db = await getDb()
  await updateSettings(db, s.workspace.id, (settings) => {
    settings.llm = { ...settings.llm, strong: applyStrongUpdate(settings.llm?.strong, input, s.workspace.id) }
    return settings
  })
  return { ok: true }
})
