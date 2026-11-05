import type { LlmSettings } from '../db/schema'
import { llmConfig, llmStatus, PRESETS, PROVIDER_REGION, STEP_ROLES, STRONG_PROVIDERS, strongBaseUrl, storedStrongKey, strongLlmConfig, DEFAULT_STRONG_PROVIDER, modelPrice, type LlmStep } from './llm'

export function publicStrong(settings: LlmSettings | undefined, workspaceId: string, admin: boolean) {
  const s = settings?.strong
  const cfg = strongLlmConfig(settings, undefined, workspaceId, true)
  const std = llmConfig(settings, undefined, workspaceId)
  const own = storedStrongKey(s, workspaceId)
  const status = cfg ? llmStatus(cfg) : { configured: false, reason: 'no_model' as const }
  return {
    enabled: !!s?.enabled,
    provider: cfg?.provider ?? DEFAULT_STRONG_PROVIDER,
    baseUrl: cfg?.baseUrl ?? strongBaseUrl(s),
    model: cfg?.model ?? PRESETS[DEFAULT_STRONG_PROVIDER].strongModel ?? '',
    key: {
      source: cfg?.keySource ?? 'none',
      own: !!s?.key && !own.unreadable,
      shared: !!cfg && cfg.keySource !== 'none' && !s?.key,
      hint: admin && s?.key ? s.key.hint : null,
      unreadable: own.unreadable,
      needed: cfg?.needsKey ?? true,
    },
    active: !!s?.enabled && status.configured,
    status,
    standardModel: std.model,
    steps: (Object.keys(STEP_ROLES) as LlmStep[]).filter(k => STEP_ROLES[k] === 'stark'),
    providers: STRONG_PROVIDERS.map(id => {
      const p = PRESETS[id]
      const model = p.strongModel ?? p.model
      const price = modelPrice(model)
      return { id, baseUrl: p.baseUrl, model, needsKey: p.needsKey, region: PROVIDER_REGION[id], price: price ? { in: Math.round(price.inEur * 100) / 100, out: Math.round(price.outEur * 100) / 100 } : null }
    }),
  }
}
