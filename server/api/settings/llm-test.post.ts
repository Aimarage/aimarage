import { getDb } from '~~/server/lib/db'
import { withLlmRun } from '~~/server/lib/agent'
import { chat, effectiveBaseUrl, LlmError, llmConfig, llmLocked, llmStatus, llmUrlError, PRESETS, type Provider } from '~~/server/lib/llm'

const body = z.object({
  provider: z.enum(Object.keys(PRESETS) as [Provider, ...Provider[]]).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().max(512).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  if (llmLocked() && (input.provider || input.baseUrl || input.model || input.apiKey)) throw createError({ statusCode: 403, statusMessage: 'KI-Einstellungen sind vom Betreiber vorgegeben' })
  if (input.baseUrl && !/^https?:\/\//.test(input.baseUrl)) return { ok: false, code: 'other', error: 'Endpunkt muss mit http:// oder https:// beginnen' }
  const urlError = await llmUrlError(effectiveBaseUrl({ ...s.workspace.settings?.llm, ...(input.provider ? { provider: input.provider } : {}), ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}) }))
  if (urlError) return { ok: false, code: 'other', error: urlError }
  const saved = s.workspace.settings?.llm
  const merged = { ...saved, ...(input.provider ? { provider: input.provider } : {}), ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}), ...(input.model ? { model: input.model, modelFast: input.model } : {}) }
  if (effectiveBaseUrl(merged) !== effectiveBaseUrl(saved)) delete merged.key
  let cfg = llmConfig(merged, undefined, s.workspace.id)
  if (input.apiKey) cfg = { ...cfg, apiKey: input.apiKey, keySource: 'workspace' }
  const st = llmStatus(cfg)
  if (!st.configured) return { ok: false, code: st.reason }
  const started = Date.now()
  try {
    const res = await withLlmRun(await getDb(), s.workspace, 'llm_test', () => chat({ ...cfg, timeoutMs: 30_000 }, { fast: true, maxTokens: 400, temperature: 0, messages: [{ role: 'user', content: 'Antworte nur mit: OK' }] }, fetch, 1))
    return { ok: true, model: res.model, reply: res.content.slice(0, 40), ms: Date.now() - started }
  }
  catch (err) {
    return { ok: false, code: err instanceof LlmError ? err.code : 'other', error: (err as Error).message.slice(0, 300) }
  }
})
