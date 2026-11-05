import { getDb } from '~~/server/lib/db'
import { withLlmRun } from '~~/server/lib/agent'
import { pausedLimit } from '~~/server/lib/limits'
import { chat, LlmError, llmStatus, OWN_PROVIDERS, type OwnProvider } from '~~/server/lib/llm'
import { applyOwnLlmUpdate, clearOwnLlmError, ownLlmAllowed, ownLlmConfig } from '~~/server/lib/own-llm'

const body = z.object({
  provider: z.enum(Object.keys(OWN_PROVIDERS) as [OwnProvider, ...OwnProvider[]]).optional(),
  model: z.string().trim().max(120).regex(/^[\w./:@-]*$/).optional(),
  apiKey: z.string().trim().max(512).optional(),
}).strict()

// Testet den eingegebenen oder gespeicherten eigenen Schlüssel. Klappt der Test mit dem gespeicherten, wird eine Sperre aufgehoben.
export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const ws = s.workspace
  if (!ownLlmAllowed(ws)) {
    if (ws.pausedAt) throw pausedLimit('llmEurMonth', 'Eigener KI-Schlüssel erst mit laufendem Tarif')
    throw createError({ statusCode: 403, statusMessage: 'Eigener KI-Schlüssel ist hier nicht verfügbar' })
  }
  const saved = ws.settings?.ownLlm
  const draft = applyOwnLlmUpdate(saved, { provider: input.provider, model: input.model, apiKey: input.apiKey?.trim() || undefined }, ws.id)
  const usesSaved = !input.apiKey?.trim() && !!draft?.key && draft.key.enc === saved?.key?.enc
  const cfg = ownLlmConfig(draft, ws.id)
  if (!cfg) return { ok: false, code: 'no_key' }
  const st = llmStatus(cfg)
  if (!st.configured) return { ok: false, code: st.reason }
  const started = Date.now()
  try {
    const res = await withLlmRun(await getDb(), ws, 'llm_test', () => chat({ ...cfg, timeoutMs: 90_000 }, { fast: true, maxTokens: 400, temperature: 0, messages: [{ role: 'user', content: 'Antworte nur mit: OK' }] }, fetch, 1))
    const sameModel = !input.model || input.model === ownLlmConfig(saved, ws.id)?.model
    const cleared = usesSaved && sameModel ? await clearOwnLlmError(await getDb(), ws.id) : false
    return { ok: true, model: res.model, reply: res.content.slice(0, 40), ms: Date.now() - started, cleared }
  }
  catch (err) {
    return { ok: false, code: err instanceof LlmError ? (err.ownKey === 'quota' ? 'rate' : err.code) : 'other', error: (err as Error).message.slice(0, 300) }
  }
})
