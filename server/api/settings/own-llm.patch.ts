import { getDb } from '~~/server/lib/db'
import { updateSettings } from '~~/server/lib/connections'
import { pausedLimit } from '~~/server/lib/limits'
import { OWN_PROVIDERS, type OwnProvider } from '~~/server/lib/llm'
import { applyOwnLlmUpdate, ownLlmAllowed, resumeAfterOwnLlmFix } from '~~/server/lib/own-llm'

// Keine Adresse im Body: gehostet gilt nur die feste Adresse des gewählten Anbieters (strict lehnt baseUrl ab).
const body = z.object({
  provider: z.enum(Object.keys(OWN_PROVIDERS) as [OwnProvider, ...OwnProvider[]]).optional(),
  model: z.string().trim().max(120).regex(/^[\w./:@-]*$/, 'Ungültiger Modellname').optional(),
  modelFast: z.string().trim().max(120).regex(/^[\w./:@-]*$/, 'Ungültiger Modellname').optional(),
  apiKey: z.string().trim().min(8).max(512).regex(/^\S+$/).optional(),
  remove: z.boolean().optional(),
}).strict()

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const ws = s.workspace
  if (!input.remove && !ownLlmAllowed(ws)) {
    if (ws.pausedAt) throw pausedLimit('llmEurMonth', 'Eigener KI-Schlüssel erst mit laufendem Tarif')
    throw createError({ statusCode: 403, statusMessage: 'Eigener KI-Schlüssel ist hier nicht verfügbar' })
  }
  if (!input.remove && !input.provider && !ws.settings?.ownLlm?.provider) throw createError({ statusCode: 400, statusMessage: 'Bitte einen Anbieter wählen' })
  const db = await getDb()
  let hadError = false
  let active = false
  await updateSettings(db, ws.id, (settings) => {
    hadError = !!settings.ownLlm?.error
    const next = applyOwnLlmUpdate(settings.ownLlm, input, ws.id)
    if (next) settings.ownLlm = next
    else delete settings.ownLlm
    active = !!next?.key
    return settings
  })
  if (hadError && active) await resumeAfterOwnLlmFix(db, ws.id)
  return { ok: true }
})
