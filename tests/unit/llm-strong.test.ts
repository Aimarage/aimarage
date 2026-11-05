import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyStrongUpdate, chat, chatJson, llmConfig, llmForStep, modelPrice, publicLlmSettings, STEP_ROLES, strongLlmConfig, USD_EUR } from '../../server/lib/llm'
import { resetSecretCache } from '../../server/lib/secret'
import type { LlmSettings } from '../../server/db/schema'
import { z } from 'zod'

const env = { baseUrl: '', apiKey: 'phala-env-key-0123456789', model: '', modelFast: '', timeoutMs: 5000 }
const WS = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  process.env.APP_SECRET = 'test-secret'
  delete process.env.APP_SECRET_FILE
  resetSecretCache()
})

afterAll(() => {
  delete process.env.APP_SECRET
  resetSecretCache()
})

type Reply = { status: number, body: unknown, headers?: Record<string, string> } | Error

function fakeFetch(replies: Reply[]) {
  const calls: { url: string, body: Record<string, unknown>, headers: Headers }[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')), headers: new Headers(init?.headers) })
    const r = replies.shift()
    if (!r) throw new Error('keine Antwort mehr')
    if (r instanceof Error) throw r
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } })
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

const oa = (content: string, model = 'm', usage: Record<string, number> = { prompt_tokens: 1000, completion_tokens: 500 }) => ({ status: 200, body: { model, choices: [{ message: { content } }], usage } })
const claude = (text: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 }, ...extra } })

const strongPhala: LlmSettings = { strong: { enabled: true, provider: 'phala', model: 'z-ai/glm-5.3' } }

describe('Rollen', () => {
  it('Routine bleibt Standard, wichtige Schritte sind stark', () => {
    expect(STEP_ROLES.draft_social).toBe('standard')
    expect(STEP_ROLES.briefing).toBe('standard')
    expect(STEP_ROLES.strategy).toBe('stark')
    expect(STEP_ROLES.weekly_review).toBe('stark')
    expect(STEP_ROLES.thread_relevance).toBe('stark')
    expect(STEP_ROLES.draft_check).toBe('stark')
    expect(STEP_ROLES.draft_article).toBe('stark')
    expect(STEP_ROLES.task_chat).toBe('stark')
  })

  it('ohne Eintrag fällt alles auf Standard zurück', () => {
    const cfg = llmForStep(undefined, 'strategy', env, WS)
    expect(cfg.model).toBe('qwen/qwen3.8-27b')
    expect(cfg.role).toBe('standard')
    expect(cfg.fallback).toBeUndefined()
  })

  it('ausgeschaltet heißt Standard', () => {
    const cfg = llmForStep({ strong: { ...strongPhala.strong, enabled: false } }, 'strategy', env, WS)
    expect(cfg.model).toBe('qwen/qwen3.8-27b')
  })

  it('starker Schritt nutzt das starke Modell mit Standard als Ersatz, Routine nicht', () => {
    const strong = llmForStep(strongPhala, 'strategy', env, WS)
    expect(strong.model).toBe('z-ai/glm-5.3')
    expect(strong.role).toBe('stark')
    expect(strong.fallback?.model).toBe('qwen/qwen3.8-27b')
    expect(llmForStep(strongPhala, 'draft_social', env, WS).model).toBe('qwen/qwen3.8-27b')
  })

  it('gleicher Anbieter teilt den Schlüssel, fremder Anbieter nicht', () => {
    expect(strongLlmConfig(strongPhala, env, WS)?.apiKey).toBe(env.apiKey)
    const mistral = strongLlmConfig({ strong: { enabled: true, provider: 'mistral' } }, env, WS)
    expect(mistral?.apiKey).toBe('')
    expect(mistral?.model).toBe('mistral-large-4-0')
    expect(llmForStep({ strong: { enabled: true, provider: 'mistral' } }, 'strategy', env, WS).model).toBe('qwen/qwen3.8-27b')
  })

  it('eigener Schlüssel wird verschlüsselt gespeichert und nicht nach außen gegeben', () => {
    const s = applyStrongUpdate(undefined, { enabled: true, provider: 'anthropic', apiKey: 'sk-ant-test-0123456789abcdef' }, WS)
    expect(JSON.stringify(s)).not.toContain('sk-ant-test-0123456789abcdef')
    expect(s.key?.hint).toBe('cdef')
    const cfg = strongLlmConfig({ strong: s }, env, WS)
    expect(cfg?.apiKey).toBe('sk-ant-test-0123456789abcdef')
    expect(cfg?.model).toBe('claude-sonnet-5-5')
    expect(strongLlmConfig({ strong: s }, env, 'anderer-ws')?.apiKey).toBe('')
    expect(publicLlmSettings({ strong: s, model: 'x' })).toEqual({ model: 'x' })
  })

  it('Wechsel der Adresse verwirft den Schlüssel', () => {
    const s = applyStrongUpdate(undefined, { enabled: true, provider: 'mistral', apiKey: 'mistral-key-0123456789' }, WS)
    expect(applyStrongUpdate(s, { provider: 'scaleway' }, WS).key).toBeUndefined()
    expect(applyStrongUpdate(s, { model: 'mistral-medium-3-5' }, WS).key).toBeDefined()
  })
})

describe('Fallback', () => {
  it('429 beim starken Modell: einmal auf Standard, im Ergebnis vermerkt', async () => {
    const cfg = llmForStep(strongPhala, 'weekly_review', env, WS)
    const { fn, calls } = fakeFetch([
      { status: 429, body: 'rate', headers: { 'retry-after': '0' } },
      { status: 429, body: 'rate', headers: { 'retry-after': '0' } },
      oa('Standard-Antwort', 'qwen/qwen3.8-27b'),
    ])
    const res = await chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, fn, 4, 0)
    expect(res.content).toBe('Standard-Antwort')
    expect(res.model).toBe('qwen/qwen3.8-27b')
    expect(res.note).toMatch(/Starkes Modell z-ai\/glm-5.3 ausgefallen \(HTTP 429\)/)
    expect(calls.map(c => c.body.model)).toEqual(['z-ai/glm-5.3', 'z-ai/glm-5.3', 'qwen/qwen3.8-27b'])
  })

  it('Zeitüberschreitung beim starken Modell fällt zurück', async () => {
    const cfg = llmForStep(strongPhala, 'strategy', env, WS)
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    const { fn } = fakeFetch([abort, abort, oa('ok', 'qwen/qwen3.8-27b')])
    const res = await chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, fn, 4, 0)
    expect(res.note).toMatch(/Zeitüberschreitung/)
  })

  it('5xx bei Anthropic fällt auf Standard zurück, Schlüssel taucht nirgends auf', async () => {
    const s = applyStrongUpdate(undefined, { enabled: true, provider: 'anthropic', apiKey: 'sk-ant-test-0123456789abcdef' }, WS)
    const cfg = llmForStep({ strong: s }, 'draft_check', env, WS)
    const { fn, calls } = fakeFetch([
      { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
      { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
      oa('ok', 'qwen/qwen3.8-27b'),
    ])
    const res = await chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, fn, 4, 0)
    expect(res.content).toBe('ok')
    expect(res.note).toMatch(/claude-sonnet-5-5 ausgefallen \(HTTP 529\)/)
    expect(res.note).not.toContain('sk-ant')
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(calls[0]!.headers.get('x-api-key')).toBe('sk-ant-test-0123456789abcdef')
  })

  it('ohne Ersatz bleibt der Fehler', async () => {
    const cfg = strongLlmConfig(strongPhala, env, WS)!
    const { fn } = fakeFetch([{ status: 500, body: 'x' }])
    await expect(chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, fn, 1, 0)).rejects.toThrow(/HTTP 500/)
  })
})

describe('Anthropic', () => {
  const s = applyStrongUpdate(undefined, { enabled: true, provider: 'anthropic', apiKey: 'sk-ant-test-0123456789abcdef' }, WS)
  const cfg = strongLlmConfig({ strong: s }, env, WS)!

  it('wandelt System, Werkzeuge und Ergebnisse um und liest Text und Kosten', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Fertig' }, { type: 'tool_use', id: 'tu_2', name: 'list_tasks', input: { day: 'heute' } }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 500 } } }])
    const res = await chat(cfg, {
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'Hallo' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tu_1', name: 'list_tasks', arguments: '{"day":"gestern"}' }] },
        { role: 'tool', content: '[]', toolCallId: 'tu_1' },
      ],
      tools: [{ name: 'list_tasks', description: 'Aufgaben', parameters: { type: 'object', properties: {} } }],
      maxTokens: 500,
    }, fn, 1)
    const body = calls[0]!.body
    expect(body.system).toBe('SYS')
    expect(body.model).toBe('claude-sonnet-5-5')
    expect(body.fallbacks).toBe('default')
    expect(calls[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hallo' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'list_tasks', input: { day: 'gestern' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '[]' }] },
    ])
    expect((body.tools as { name: string }[])[0]!.name).toBe('list_tasks')
    expect(res.content).toBe('Fertig')
    expect(res.toolCalls).toEqual([{ id: 'tu_2', name: 'list_tasks', arguments: '{"day":"heute"}' }])
    expect(res.costEur).toBeCloseTo((1000 * 2 + 500 * 10) / 1e6 * USD_EUR, 8)
  })

  it('JSON-Antworten funktionieren auch mit Claude', async () => {
    const { fn } = fakeFetch([claude('```json\n{"a": 1}\n```')])
    const r = await chatJson(cfg, { messages: [{ role: 'user', content: 'x' }] }, z.object({ a: z.number() }), fn)
    expect(r.data.a).toBe(1)
  })

  it('Ablehnung zählt als Ausfall', async () => {
    const { fn } = fakeFetch([claude('', { content: [], stop_reason: 'refusal' })])
    await expect(chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, fn, 1)).rejects.toThrow(/abgelehnt/)
  })
})

describe('Kosten', () => {
  it('Preise je Modell', () => {
    expect(modelPrice('z-ai/glm-5.3')!.inEur).toBeCloseTo(1.4 * USD_EUR)
    expect(modelPrice('mistral-medium-3.5-128b')).toEqual({ inEur: 1.5, outEur: 7.5 })
    expect(modelPrice('unbekannt')).toBeNull()
  })

  it('Kosten nach dem tatsächlich genutzten Modell', async () => {
    const cfg = strongLlmConfig(strongPhala, env, WS)!
    const { fn } = fakeFetch([oa('ok', 'z-ai/glm-5.3')])
    const res = await chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, fn, 1)
    expect(res.costEur).toBeCloseTo((1000 * 1.4 + 500 * 4.4) / 1e6 * USD_EUR, 8)
  })

  it('vom Anbieter gemeldete Kosten haben Vorrang', async () => {
    const cfg = llmConfig(undefined, env, WS)
    const { fn } = fakeFetch([oa('ok', 'qwen/qwen3.8-27b', { prompt_tokens: 1000, completion_tokens: 500, cost: 0.01 })])
    const res = await chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, fn, 1)
    expect(res.costEur).toBeCloseTo(0.01 * USD_EUR, 8)
  })

  it('Kosten des ausgefallenen Versuchs werden beim Ersatz mitgezählt', async () => {
    const cfg = llmForStep(strongPhala, 'strategy', env, WS)
    const { fn } = fakeFetch([
      { status: 200, body: { model: 'z-ai/glm-5.3', choices: [{ message: { content: '', reasoning: 'hmm' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 100 } } },
      { status: 200, body: { model: 'z-ai/glm-5.3', choices: [{ message: { content: '', reasoning: 'hmm' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 100 } } },
      oa('ok', 'qwen/qwen3.8-27b'),
    ])
    const res = await chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, fn, 4, 0)
    expect(res.tokensIn).toBe(1200)
    expect(res.note).toMatch(/leere Antwort/)
  })
})
