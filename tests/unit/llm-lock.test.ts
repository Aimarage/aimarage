import { afterEach, describe, expect, it } from 'vitest'
import { llmConfig, strongLlmConfig } from '../../server/lib/llm'

const env = { baseUrl: 'https://api.mistral.ai/v1', apiKey: 'env-key-123456789', model: 'mistral-large-latest', modelFast: 'mistral-small-latest', timeoutMs: 1000 }
const own = { provider: 'custom' as const, baseUrl: 'https://llm.kunde.example/v1', model: 'eigenes', strong: { enabled: true, provider: 'anthropic' as const } }

afterEach(() => {
  delete process.env.LLM_SETTINGS_LOCKED
})

describe('LLM_SETTINGS_LOCKED', () => {
  it('ohne Sperre gelten die Workspace-Einstellungen', () => {
    expect(llmConfig(own, env, 'ws').baseUrl).toBe('https://llm.kunde.example/v1')
    expect(strongLlmConfig(own, env, 'ws')).not.toBeNull()
  })
  it('mit Sperre gilt nur die .env, starkes Modell aus', () => {
    process.env.LLM_SETTINGS_LOCKED = 'true'
    const cfg = llmConfig(own, env, 'ws')
    expect(cfg.baseUrl).toBe('https://api.mistral.ai/v1')
    expect(cfg.model).toBe('mistral-large-latest')
    expect(cfg.keySource).toBe('env')
    expect(strongLlmConfig(own, env, 'ws')).toBeNull()
  })
})
