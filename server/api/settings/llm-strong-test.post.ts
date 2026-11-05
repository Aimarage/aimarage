import { getDb } from '~~/server/lib/db'
import { withLlmRun } from '~~/server/lib/agent'
import { chat, LlmError, llmLocked, llmStatus, llmUrlError, strongBaseUrl, strongLlmConfig, STRONG_PROVIDERS, type Provider } from '~~/server/lib/llm'

const body = z.object({
  provider: z.enum(STRONG_PROVIDERS as [Provider, ...Provider[]]).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().max(512).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  if (llmLocked()) throw createError({ statusCode: 403, statusMessage: 'KI-Einstellungen sind vom Betreiber vorgegeben' })
  if (input.baseUrl && !/^https?:\/\//.test(input.baseUrl)) return { ok: false, code: 'other', error: 'Adresse muss mit http:// oder https:// beginnen' }
  const saved = s.workspace.settings?.llm
  const strong = { ...saved?.strong, ...(input.provider ? { provider: input.provider } : {}), ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}), ...(input.model ? { model: input.model } : {}) }
  if (strongBaseUrl(strong) !== strongBaseUrl(saved?.strong)) delete strong.key
  const urlError = await llmUrlError(strongBaseUrl(strong))
  if (urlError) return { ok: false, code: 'other', error: urlError }
  let cfg = strongLlmConfig({ ...saved, strong }, undefined, s.workspace.id, true)
  if (!cfg) return { ok: false, code: 'no_model' }
  if (input.apiKey) cfg = { ...cfg, apiKey: input.apiKey, keySource: 'workspace' }
  const st = llmStatus(cfg)
  if (!st.configured) return { ok: false, code: st.reason }
  const started = Date.now()
  try {
    const res = await withLlmRun(await getDb(), s.workspace, 'llm_test', () => chat({ ...cfg, timeoutMs: 45_000 }, { maxTokens: 400, temperature: 0, messages: [{ role: 'user', content: 'Antworte nur mit: OK' }] }, fetch, 1))
    return { ok: true, model: res.model, reply: res.content.slice(0, 40), ms: Date.now() - started }
  }
  catch (err) {
    return { ok: false, code: err instanceof LlmError ? err.code : 'other', error: (err as Error).message.slice(0, 300) }
  }
})
