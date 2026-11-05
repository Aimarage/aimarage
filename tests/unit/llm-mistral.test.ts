import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { chat, chatJson, llmConfig, wireText } from '../../server/lib/llm'

const env = { baseUrl: 'https://api.mistral.ai/v1', apiKey: 'k', model: '', modelFast: '', timeoutMs: 5000 }

function fakeFetch(responses: { status: number, body: unknown }[]) {
  const calls: Record<string, unknown>[] = []
  const fn = async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)))
    const r = responses.shift()!
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  }
  return { fn, calls }
}

const reply = (content: unknown) => ({ status: 200, body: { model: 'mistral-large-4-0', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } })
const chunks = (text: string) => [{ type: 'thinking', thinking: [{ type: 'text', text: 'erst überlegen' }] }, { type: 'text', text }]

describe('Mistral', () => {
  const base = llmConfig({ provider: 'mistral' }, env)
  const large = { ...base, model: 'mistral-large-4-0', modelFast: 'mistral-large-4-0' }

  it('schickt reasoning_effort none bei Large, Medium und Small', async () => {
    for (const model of ['mistral-large-4-0', 'mistral-medium-3-5', 'mistral-small-latest']) {
      const f = fakeFetch([reply('ok')])
      await chat({ ...base, model }, { messages: [{ role: 'user', content: 'x' }] }, f.fn)
      expect(f.calls[0]!.reasoning_effort).toBe('none')
    }
    const f = fakeFetch([reply('ok')])
    await chat(large, { messages: [], reasoning: true }, f.fn)
    expect(f.calls[0]!.reasoning_effort).toBe('high')
  })

  it('kein reasoning_effort bei anderen Modellen und Anbietern', async () => {
    const f = fakeFetch([reply('ok'), reply('ok')])
    await chat({ ...base, model: 'codestral-latest' }, { messages: [] }, f.fn)
    await chat({ ...llmConfig({ provider: 'custom' }, { ...env, baseUrl: 'https://x.test/v1' }), model: 'mistral-large-4-0' }, { messages: [] }, f.fn)
    expect(f.calls[0]!.reasoning_effort).toBeUndefined()
    expect(f.calls[1]!.reasoning_effort).toBeUndefined()
  })

  it('eigener Schlüssel mit Anbieter mistral bekommt es auch', async () => {
    const f = fakeFetch([reply('ok')])
    await chat({ ...large, provider: 'custom', ownProvider: 'mistral' }, { messages: [] }, f.fn)
    expect(f.calls[0]!.reasoning_effort).toBe('none')
  })

  it('lässt reasoning_effort weg, wenn Mistral es ablehnt', async () => {
    const f = fakeFetch([{ status: 400, body: 'reasoning_effort not supported' }, reply('ok')])
    const res = await chat(large, { messages: [] }, f.fn)
    expect(res.content).toBe('ok')
    expect(f.calls[1]!.reasoning_effort).toBeUndefined()
  })

  it('setzt Content-Teile zusammen und verwirft thinking', async () => {
    const f = fakeFetch([reply(chunks('Hallo'))])
    const res = await chat(large, { messages: [] }, f.fn)
    expect(res.content).toBe('Hallo')
    expect(wireText([{ type: 'text', text: 'a' }, { type: 'thinking' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(wireText(null)).toBe('')
  })

  it('nur thinking: einmal mit mehr Platz wiederholen', async () => {
    const f = fakeFetch([reply([{ type: 'thinking', thinking: [] }]), reply(chunks('fertig'))])
    const res = await chat(large, { messages: [] }, f.fn)
    expect(res.content).toBe('fertig')
    expect(f.calls).toHaveLength(2)
  })

  it('JSON aus Teilen und ```json-Block', async () => {
    const f = fakeFetch([reply(chunks('Hier:\n```json\n{"a": 1}\n```'))])
    const res = await chatJson(large, { messages: [] }, z.object({ a: z.number() }), f.fn)
    expect(res.data.a).toBe(1)
  })
})
