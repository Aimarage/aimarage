import { afterEach, describe, expect, it } from 'vitest'
import { chat, euAvailable, euLlmForStep, euProvider, llmConfig, llmForStep, llmStatus, modelPrice, USD_EUR, writerFrom } from '../../server/lib/llm'

const haikuEnv = { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-env-0123456789abcdef', model: 'claude-haiku-5-5', modelFast: 'claude-haiku-5-5', timeoutMs: 5000 }
const euEnv = { baseUrl: 'https://api.scaleway.ai/v1', apiKey: 'scw-eu-0123456789abcdef', model: 'qwen3.8-27b', modelFast: '', timeoutMs: 5000 }
const WS = '11111111-1111-1111-1111-111111111111'

type Reply = { status: number, body: unknown }

function fakeFetch(replies: Reply[]) {
  const calls: { url: string, body: Record<string, unknown> }[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    const r = replies.shift()
    if (!r) throw new Error('keine Antwort mehr')
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }
  return { fn: fn as unknown as (url: string, init: RequestInit) => Promise<Response>, calls }
}

const claude = (text: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: text ? [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }] : [{ type: 'thinking', thinking: '', signature: 's' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 }, ...extra } })

describe('Haiku 5.5 als Standard', () => {
  it('Anthropic aus der .env mit Haiku-Preisen', () => {
    const cfg = llmConfig(undefined, haikuEnv, WS)
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.model).toBe('claude-haiku-5-5')
    expect(cfg.keySource).toBe('env')
    expect(llmStatus(cfg).configured).toBe(true)
    expect(cfg.priceInEur).toBeCloseTo(0.1 * USD_EUR, 8)
    expect(cfg.priceOutEur).toBeCloseTo(0.5 * USD_EUR, 8)
    expect(llmConfig({ provider: 'anthropic' }, { ...haikuEnv, model: '' }).model).toBe('claude-haiku-5-5')
  })

  it('lange Eingaben über 100K Token kosten mehr', () => {
    expect(modelPrice('claude-haiku-5-5', 100_000)!.inEur).toBeCloseTo(0.1 * USD_EUR, 8)
    expect(modelPrice('claude-haiku-5-5', 100_001)).toEqual({ inEur: 0.5 * USD_EUR, outEur: 2.5 * USD_EUR })
    expect(modelPrice('claude-sonnet-5-5', 200_000)!.inEur).toBeCloseTo(2 * USD_EUR, 8)
  })

  it('rechnet einen Aufruf zu Haiku-Preisen ab', async () => {
    const { fn, calls } = fakeFetch([claude('Hallo')])
    const res = await chat(llmConfig(undefined, haikuEnv, WS), { messages: [{ role: 'user', content: 'x' }], maxTokens: 400 }, fn, 1)
    expect(res.content).toBe('Hallo')
    expect(res.costEur).toBeCloseTo((1000 * 0.1 + 500 * 0.5) / 1e6 * USD_EUR, 10)
    expect(calls[0]!.body.model).toBe('claude-haiku-5-5')
    expect(calls[0]!.body.fallbacks).toBeUndefined()
    expect(calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(4000)
    expect(calls[0]!.body.output_config).toEqual({ effort: 'low' })
  })

  it('nur nachgedacht und abgeschnitten: zweiter Versuch mit mehr Platz, Kosten beider Aufrufe', async () => {
    const { fn, calls } = fakeFetch([claude('', { stop_reason: 'max_tokens' }), claude('Fertig')])
    const res = await chat(llmConfig(undefined, haikuEnv, WS), { messages: [{ role: 'user', content: 'x' }], maxTokens: 400 }, fn, 1)
    expect(res.content).toBe('Fertig')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.max_tokens).toBe(32000)
    expect(res.tokensOut).toBe(1000)
    expect(res.costEur).toBeCloseTo(2 * (1000 * 0.1 + 500 * 0.5) / 1e6 * USD_EUR, 10)
  })

  it('abgeschnittener Text wird ebenfalls mit mehr Platz wiederholt', async () => {
    const { fn, calls } = fakeFetch([claude('{"a": ', { stop_reason: 'max_tokens' }), claude('{"a": 1}')])
    const res = await chat(llmConfig(undefined, haikuEnv, WS), { messages: [{ role: 'user', content: 'x' }] }, fn, 1)
    expect(res.content).toBe('{"a": 1}')
    expect(calls).toHaveLength(2)
  })

  it('bleibt es leer, gibt es einen Fehler mit Verbrauch', async () => {
    const { fn } = fakeFetch([claude('', { stop_reason: 'max_tokens' }), claude('', { stop_reason: 'max_tokens' })])
    const err = await chat(llmConfig(undefined, haikuEnv, WS), { messages: [{ role: 'user', content: 'x' }] }, fn, 1).catch(e => e)
    expect(err.message).toMatch(/nur nachgedacht/)
    expect(err.usage.tokensOut).toBe(1000)
  })
})

describe('Opus für Blog-Artikel', () => {
  it('gehostet Anthropic: Opus mit Haiku als Ausweich, Opus-Preise', () => {
    const cfg = writerFrom(llmConfig(undefined, haikuEnv, WS), true, '')
    expect(cfg.model).toBe('claude-opus-5-5')
    expect(cfg.role).toBe('stark')
    expect(cfg.fallback?.model).toBe('claude-haiku-5-5')
    expect(cfg.priceInEur).toBeCloseTo(4 * USD_EUR, 8)
    expect(cfg.priceOutEur).toBeCloseTo(20 * USD_EUR, 8)
  })

  it('Tarif ohne starkes Modell, ohne Schlüssel oder EU-Anbieter: bleibt beim Standard', () => {
    const std = llmConfig(undefined, haikuEnv, WS)
    expect(writerFrom(std, false, '')).toBe(std)
    const noKey = llmConfig(undefined, { ...haikuEnv, apiKey: '' }, WS)
    expect(writerFrom(noKey, true, '')).toBe(noKey)
    const eu = euLlmForStep(undefined, 'draft_article', WS, euEnv)
    expect(writerFrom(eu, true, '')).toBe(eu)
  })

  it('eingestelltes starkes Modell geht vor', () => {
    const strong = llmForStep({ strong: { enabled: true, provider: 'scaleway', apiKey: undefined } } as never, 'draft_article', { ...euEnv }, WS)
    expect(writerFrom(strong, true, '')).toBe(strong)
  })

  it('eigener Anthropic-Schlüssel: Opus nur beim vorgegebenen Modell, auch ohne starkes Modell im Tarif', () => {
    const own = { ...llmConfig(undefined, haikuEnv, WS), model: 'claude-sonnet-5-5', own: true, ownProvider: 'anthropic' as const, keySource: 'workspace' as const }
    const w = writerFrom(own, false, 'claude-haiku-5-5')
    expect(w.model).toBe('claude-opus-5-5')
    expect(w.fallback?.model).toBe('claude-sonnet-5-5')
    expect(writerFrom({ ...own, model: 'claude-haiku-5-5' }, true, '').model).toBe('claude-haiku-5-5')
    expect(writerFrom({ ...own, ownProvider: 'mistral', model: 'mistral-medium-3-5' }, true, '').model).toBe('mistral-medium-3-5')
    expect(writerFrom({ ...own, blocked: 'kaputt' }, true, '').model).toBe('claude-sonnet-5-5')
  })

  it('LLM_MODEL_WRITER ersetzt die Vorgabe, gleich LLM_MODEL heißt aus', () => {
    const std = llmConfig(undefined, haikuEnv, WS)
    expect(writerFrom(std, true, 'claude-sonnet-5-5').model).toBe('claude-sonnet-5-5')
    expect(writerFrom(std, true, 'claude-haiku-5-5')).toBe(std)
  })

  it('Opus mit Server-Ausweich und Opus-Kosten', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { ...claude('Text').body, model: 'claude-opus-5-5' } }])
    const res = await chat(writerFrom(llmConfig(undefined, haikuEnv, WS), true, ''), { messages: [{ role: 'user', content: 'x' }], maxTokens: 4000 }, fn, 1)
    expect(calls[0]!.body.model).toBe('claude-opus-5-5')
    expect(calls[0]!.body.fallbacks).toBe('default')
    expect(res.costEur).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6 * USD_EUR, 10)
  })
})

describe('EU-Modus', () => {
  afterEach(() => {
    for (const k of ['LLM_EU_BASE_URL', 'LLM_EU_API_KEY', 'LLM_EU_MODEL', 'LLM_EU_MODEL_FAST']) delete process.env[k]
  })

  it('nur mit EU-Anbieter verfügbar', () => {
    expect(euAvailable(euEnv)).toBe(true)
    expect(euProvider(euEnv)).toBe('scaleway')
    expect(euAvailable({ ...euEnv, baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-medium-3-5' })).toBe(true)
    expect(euAvailable({ ...euEnv, baseUrl: 'https://inference.phala.com/v1' })).toBe(false)
    expect(euAvailable({ ...euEnv, baseUrl: 'https://cloud-api.near.ai/v1' })).toBe(false)
    expect(euAvailable({ ...euEnv, apiKey: '' })).toBe(false)
    expect(euAvailable({ ...euEnv, model: '' })).toBe(false)
  })

  it('nutzt den EU-Anbieter mit dessen Schlüssel und ignoriert eigene Anbieter-Wahl', () => {
    const cfg = euLlmForStep({ provider: 'anthropic', model: 'claude-haiku-5-5' }, 'draft_social', WS, euEnv)
    expect(cfg.provider).toBe('scaleway')
    expect(cfg.baseUrl).toBe('https://api.scaleway.ai/v1')
    expect(cfg.model).toBe('qwen3.8-27b')
    expect(cfg.apiKey).toBe(euEnv.apiKey)
    expect(llmStatus(cfg).configured).toBe(true)
  })

  it('nicht eingerichtet: kein Rückfall auf die Standard-KI', () => {
    const cfg = euLlmForStep(undefined, undefined, WS, { ...euEnv, baseUrl: '' })
    expect(llmStatus(cfg).configured).toBe(false)
    const phala = euLlmForStep(undefined, undefined, WS, { ...euEnv, baseUrl: 'https://inference.phala.com/v1' })
    expect(llmStatus(phala).configured).toBe(false)
  })

  it('starkes Modell nur, wenn es selbst in der EU läuft', () => {
    const us = euLlmForStep({ strong: { enabled: true, provider: 'anthropic' } }, 'strategy', WS, euEnv)
    expect(us.provider).toBe('scaleway')
    expect(us.fallback).toBeUndefined()
    const eu = euLlmForStep({ strong: { enabled: true, provider: 'scaleway' } }, 'strategy', WS, euEnv)
    expect(eu.model).toBe('mistral-medium-3.5-128b')
    expect(eu.fallback?.model).toBe('qwen3.8-27b')
  })

  it('liest LLM_EU_* aus der Umgebung', () => {
    expect(euAvailable()).toBe(false)
    process.env.LLM_EU_BASE_URL = euEnv.baseUrl
    process.env.LLM_EU_API_KEY = euEnv.apiKey
    process.env.LLM_EU_MODEL = euEnv.model
    expect(euAvailable()).toBe(true)
    expect(euLlmForStep(undefined, undefined, WS).modelFast).toBe('qwen3.8-27b')
  })
})
