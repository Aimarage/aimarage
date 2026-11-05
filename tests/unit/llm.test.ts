import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { chat, chatJson, extractJson, llmConfig, llmStatus, LlmNotConfiguredError } from '../../server/lib/llm'

const env = { baseUrl: '', apiKey: '', model: '', modelFast: '', timeoutMs: 5000 }

function fakeFetch(responses: { status: number, body: unknown, headers?: Record<string, string> }[]) {
  const calls: { url: string, body: Record<string, unknown>, headers: Record<string, string> }[] = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> })
    const r = responses.shift()!
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers })
  }
  return { fn, calls }
}

const ok = (content: string) => ({ status: 200, body: { model: 'm', choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } } })

describe('LLM-Konfiguration', () => {
  it('Phala ist Standard und ohne Schlüssel nicht konfiguriert', () => {
    const cfg = llmConfig(undefined, env)
    expect(cfg.provider).toBe('phala')
    expect(cfg.baseUrl).toBe('https://inference.phala.com/v1')
    expect(cfg.model).toBe('qwen/qwen3.8-27b')
    expect(llmStatus(cfg)).toEqual({ configured: false, reason: 'no_key' })
  })
  it('Ollama braucht keinen Schlüssel', () => {
    const cfg = llmConfig({ provider: 'ollama' }, env)
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1')
    expect(llmStatus(cfg).configured).toBe(true)
  })
  it('Schlüssel aus .env geht nur an LLM_BASE_URL', () => {
    const e = { ...env, baseUrl: 'https://api.scaleway.ai/v1', apiKey: 'k' }
    const cfg = llmConfig({ provider: 'scaleway', baseUrl: 'https://api.scaleway.ai/v1/' }, e)
    expect(cfg.apiKey).toBe('k')
    expect(cfg.keySource).toBe('env')
    expect(cfg.baseUrl).toBe('https://api.scaleway.ai/v1')
    expect(llmStatus(cfg).configured).toBe(true)
    expect(llmConfig({ provider: 'cerebras' }, e).apiKey).toBe('')
  })
  it('ohne LLM_BASE_URL gilt der .env-Schlüssel nur für Phala', () => {
    expect(llmConfig(undefined, { ...env, apiKey: 'k' }).apiKey).toBe('k')
    expect(llmConfig({ provider: 'near' }, { ...env, apiKey: 'k' }).apiKey).toBe('')
  })
  it('Schlüssel geht nicht an fremde Endpunkte', () => {
    const cfg = llmConfig({ provider: 'scaleway', baseUrl: 'https://x.test/v1/' }, { ...env, apiKey: 'k' })
    expect(cfg.apiKey).toBe('')
    expect(llmStatus(cfg).configured).toBe(false)
    expect(llmConfig({ provider: 'custom', baseUrl: 'https://x.test/v1' }, { ...env, baseUrl: 'https://x.test/v1/', apiKey: 'k', model: 'm' }).apiKey).toBe('k')
  })
  it('alte Einstellung openai wird zur eigenen Adresse', () => {
    expect(llmConfig({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm' }, env).provider).toBe('custom')
  })
})

describe('chat', () => {
  const cfg = { ...llmConfig({ provider: 'scaleway' }, { ...env, baseUrl: 'https://api.scaleway.ai/v1', apiKey: 'secret' }) }

  it('wirft ohne Konfiguration', async () => {
    await expect(chat(llmConfig(undefined, env), { messages: [] })).rejects.toBeInstanceOf(LlmNotConfiguredError)
  })

  it('sendet OpenAI-kompatibel und rechnet Kosten', async () => {
    const f = fakeFetch([ok('<think>hmm</think>Hallo')])
    const res = await chat(cfg, { messages: [{ role: 'user', content: 'x' }] }, f.fn)
    expect(res.content).toBe('Hallo')
    expect(f.calls[0]!.url).toBe('https://api.scaleway.ai/v1/chat/completions')
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer secret')
    expect(f.calls[0]!.body.reasoning_effort).toBe('none')
    expect(res.costEur).toBeCloseTo((100 * 0.6 + 50 * 3.3) / 1e6)
  })

  it('wiederholt bei 429 mit Retry-After', async () => {
    const f = fakeFetch([{ status: 429, body: 'slow down', headers: { 'retry-after': '0.01' } }, { status: 503, body: 'x', headers: { 'retry-after': '0.01' } }, ok('ok')])
    const res = await chat(cfg, { messages: [] }, f.fn, 4, 0.01)
    expect(res.content).toBe('ok')
    expect(f.calls).toHaveLength(3)
  })

  it('gibt bei 400 sofort auf', async () => {
    const f = fakeFetch([{ status: 400, body: 'bad' }])
    await expect(chat(cfg, { messages: [] }, f.fn)).rejects.toThrow('HTTP 400')
    expect(f.calls).toHaveLength(1)
  })

  it('JSON mit einer Reparatur-Anfrage', async () => {
    const f = fakeFetch([ok('kein json'), ok('```json\n{"body": "Text"}\n```')])
    const res = await chatJson(cfg, { messages: [] }, z.object({ body: z.string() }), f.fn)
    expect(res.data.body).toBe('Text')
    expect(res.usage).toHaveLength(2)
  })

  it('nach gescheiterter Reparatur einmal frisch mit Hinweis', async () => {
    const f = fakeFetch([ok('kein json'), ok('immer noch nicht'), ok('{"body": "Text"}')])
    const res = await chatJson(cfg, { messages: [{ role: 'user', content: 'x' }] }, z.object({ body: z.string() }), f.fn)
    expect(res.data.body).toBe('Text')
    expect(res.usage).toHaveLength(3)
    expect(JSON.stringify(f.calls[2]!.body)).toContain('Wichtig: Antworte ausschließlich')
  })

  it('extractJson findet das Objekt im Text', () => {
    expect(extractJson('Hier: {"a": 1} fertig')).toEqual({ a: 1 })
  })
})

describe('JSON-Toleranz', () => {
  it('rohe Zeilenumbrüche in Strings werden repariert', () => {
    expect(extractJson('{"body": "Zeile 1\nZeile 2\t!", "x": "a\\"b"}')).toEqual({ body: 'Zeile 1\nZeile 2\t!', x: 'a"b' })
  })
  // Rohantwort wie am 13.10. (Blog-Artikel mit Code-Snippets, gekürzt und anonymisiert): der erste Codeblock steckt im body-String.
  const article = JSON.stringify({ kind: 'article', subject: 'Bookmark Manager with MCP Server', recipient: '', targetUrl: '', body: 'Intro.\n\n## Setup\n\n```json\n{\n  "mcpServers": {\n    "example": { "url": "https://example.net/mcp" }\n  }\n}\n```\n\nThen:\n\n```bash\nnpx example\n```\n\nDone.', missing: [], notes: 'Prüfen.' })

  it('Codeblöcke im body verdecken das JSON nicht', () => {
    const r = extractJson(article) as { kind: string, body: string }
    expect(r.kind).toBe('article')
    expect(r.body).toContain('"mcpServers"')
  })

  it('JSON im äußeren Codeblock mit Codeblöcken im body', () => {
    expect((extractJson(`\`\`\`json\n${article}\n\`\`\``) as { kind: string }).kind).toBe('article')
    expect((extractJson(`Hier der Entwurf:\n${article}\nFertig.`) as { kind: string }).kind).toBe('article')
  })

  it('ohne Klammern: Kein JSON gefunden', () => {
    expect(() => extractJson('nur Text')).toThrow('Kein JSON gefunden')
  })
})
