import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyLlmUpdate, chat, llmConfig, llmStatus, publicLlmSettings, redactKey } from '../../server/lib/llm'
import { decryptSecret, encryptSecret, resetSecretCache } from '../../server/lib/secret'

const env = { baseUrl: '', apiKey: '', model: '', modelFast: '', timeoutMs: 5000 }
const WS = '11111111-1111-1111-1111-111111111111'
const KEY = 'phala-test-key-0123456789abcd'
const tmp = mkdtempSync(join(tmpdir(), 'ma-secret-'))

beforeEach(() => {
  process.env.APP_SECRET = 'test-secret'
  delete process.env.APP_SECRET_FILE
  resetSecretCache()
})

afterAll(() => {
  delete process.env.APP_SECRET
  resetSecretCache()
  rmSync(tmp, { recursive: true, force: true })
})

function fakeFetch(responses: { status: number, body: unknown }[]) {
  const calls: { url: string, body: Record<string, unknown>, headers: Record<string, string> }[] = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> })
    const r = responses.shift()!
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  }
  return { fn, calls }
}

describe('Verschlüsselung', () => {
  it('AES-GCM rund, Kontext gebunden, manipulationssicher', () => {
    const enc = encryptSecret(KEY, 'ctx-a')
    expect(enc.startsWith('v1.')).toBe(true)
    expect(enc).not.toContain(KEY)
    expect(encryptSecret(KEY, 'ctx-a')).not.toBe(enc)
    expect(decryptSecret(enc, 'ctx-a')).toBe(KEY)
    expect(decryptSecret(enc, 'ctx-b')).toBeNull()
    const raw = Buffer.from(enc.slice(3), 'base64url')
    raw[raw.length - 1]! ^= 1
    expect(decryptSecret(`v1.${raw.toString('base64url')}`, 'ctx-a')).toBeNull()
  })
  it('anderes APP_SECRET kann nicht entschlüsseln', () => {
    const enc = encryptSecret(KEY, 'c')
    process.env.APP_SECRET = 'other'
    resetSecretCache()
    expect(decryptSecret(enc, 'c')).toBeNull()
  })
  it('ohne APP_SECRET wird eine Schlüsseldatei mit Rechten 600 angelegt und wiederverwendet', () => {
    delete process.env.APP_SECRET
    process.env.APP_SECRET_FILE = join(tmp, 'sub', 'app-secret')
    resetSecretCache()
    const enc = encryptSecret(KEY, 'c')
    const file = process.env.APP_SECRET_FILE
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8').trim().length).toBeGreaterThan(30)
    resetSecretCache()
    expect(decryptSecret(enc, 'c')).toBe(KEY)
  })
})

describe('Schlüssel je Arbeitsbereich', () => {
  const phala = () => applyLlmUpdate(undefined, { provider: 'phala', apiKey: KEY }, WS, env)

  it('wird verschlüsselt gespeichert, nur Endung sichtbar', () => {
    const s = phala()
    expect(JSON.stringify(s)).not.toContain(KEY)
    expect(s.key?.hint).toBe('abcd')
    expect(s.key?.baseUrl).toBe('https://inference.phala.com/v1')
    expect(publicLlmSettings(s)).not.toHaveProperty('key')
    const cfg = llmConfig(s, env, WS)
    expect(cfg.apiKey).toBe(KEY)
    expect(cfg.keySource).toBe('workspace')
    expect(llmStatus(cfg).configured).toBe(true)
  })
  it('gilt nur im eigenen Arbeitsbereich', () => {
    expect(llmConfig(phala(), env, '22222222-2222-2222-2222-222222222222').apiKey).toBe('')
  })
  it('Arbeitsbereich vor .env', () => {
    const e = { ...env, baseUrl: 'https://inference.phala.com/v1', apiKey: 'env-key-zzzzzzzzzz' }
    expect(llmConfig(undefined, e, WS).apiKey).toBe('env-key-zzzzzzzzzz')
    expect(llmConfig(undefined, e, WS).keySource).toBe('env')
    const cfg = llmConfig(phala(), e, WS)
    expect(cfg.apiKey).toBe(KEY)
    expect(cfg.keySource).toBe('workspace')
    const removed = applyLlmUpdate(phala(), { removeKey: true }, WS, e)
    expect(removed.key).toBeUndefined()
    expect(llmConfig(removed, e, WS).keySource).toBe('env')
  })
  it('URL-Wechsel verwirft den Schlüssel', () => {
    const s = applyLlmUpdate(phala(), { provider: 'custom', baseUrl: 'https://evil.test/v1', model: 'm' }, WS, env)
    expect(s.key).toBeUndefined()
    const cfg = llmConfig(s, env, WS)
    expect(cfg.apiKey).toBe('')
    expect(llmStatus(cfg).configured).toBe(false)
  })
  it('Anbieterwechsel verwirft den Schlüssel, Modellwechsel nicht', () => {
    expect(applyLlmUpdate(phala(), { provider: 'near' }, WS, env).key).toBeUndefined()
    const s = applyLlmUpdate(phala(), { model: 'qwen/other', baseUrl: 'https://inference.phala.com/v1/' }, WS, env)
    expect(s.key?.hint).toBe('abcd')
    expect(llmConfig(s, env, WS).apiKey).toBe(KEY)
  })
  it('neue URL mit neuem Schlüssel', () => {
    const s = applyLlmUpdate(phala(), { provider: 'cerebras', apiKey: 'csk-new-key-9999' }, WS, env)
    expect(s.key?.baseUrl).toBe('https://api.cerebras.ai/v1')
    expect(llmConfig(s, env, WS).apiKey).toBe('csk-new-key-9999')
  })
  it('von Hand umgebogene URL in der DB bekommt keinen Schlüssel', () => {
    const s = { ...phala(), baseUrl: 'https://evil.test/v1' }
    expect(llmConfig(s, env, WS).apiKey).toBe('')
    const forged = { ...s, key: { ...s.key!, baseUrl: 'https://evil.test/v1' } }
    expect(llmConfig(forged, env, WS).apiKey).toBe('')
  })
  it('Fehlertexte enthalten den Schlüssel nicht', () => {
    expect(redactKey(`Incorrect API key provided: ${KEY}`, KEY)).not.toContain(KEY)
    expect(redactKey('invalid key sk-abcdefghijklmnop1234', '')).toBe('invalid key ***')
  })
})

describe('Denkende Modelle (Qwen3.8)', () => {
  const cfg = () => llmConfig(applyLlmUpdate(undefined, { provider: 'phala', apiKey: KEY }, WS, env), env, WS)
  const thinking = { status: 200, body: { model: 'q', choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'Hmm ...' } }], usage: { prompt_tokens: 10, completion_tokens: 300 } } }
  const answer = { status: 200, body: { model: 'q', choices: [{ finish_reason: 'stop', message: { content: 'OK', reasoning_content: 'kurz' } }], usage: { prompt_tokens: 10, completion_tokens: 20 } } }

  it('schaltet Denken ab, schickt genug Tokens und ignoriert reasoning_content', async () => {
    const f = fakeFetch([answer])
    const res = await chat(cfg(), { maxTokens: 20, messages: [{ role: 'user', content: 'x' }] }, f.fn)
    expect(res.content).toBe('OK')
    expect(f.calls[0]!.url).toBe('https://inference.phala.com/v1/chat/completions')
    expect(f.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(f.calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(256)
    expect(f.calls[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })
  it('leerer content nach Denken: einmal mit mehr Tokens nachfragen', async () => {
    const f = fakeFetch([thinking, answer])
    const res = await chat(cfg(), { maxTokens: 300, messages: [] }, f.fn)
    expect(res.content).toBe('OK')
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]!.body.max_tokens).toBeGreaterThanOrEqual(4000)
    expect(res.tokensOut).toBe(320)
  })
  it('bleibt es leer, klare Fehlermeldung', async () => {
    const f = fakeFetch([thinking, thinking])
    await expect(chat(cfg(), { messages: [] }, f.fn)).rejects.toMatchObject({ code: 'empty' })
  })
  it('kennt der Anbieter den Denken-aus-Schalter nicht, ohne ihn erneut', async () => {
    const c = { ...cfg(), baseUrl: 'https://inference.phala.com/v1x' }
    const f = fakeFetch([{ status: 400, body: 'unknown field chat_template_kwargs' }, answer])
    const res = await chat(c, { messages: [] }, f.fn)
    expect(res.content).toBe('OK')
    expect(f.calls[1]!.body.chat_template_kwargs).toBeUndefined()
  })
  it('abgeschnittenes <think> wird entfernt', async () => {
    const f = fakeFetch([{ status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '<think>lange Gedanken' } }] } }, answer])
    expect((await chat(cfg(), { messages: [] }, f.fn)).content).toBe('OK')
  })
  it('401 wird als Schlüsselfehler erkannt', async () => {
    const f = fakeFetch([{ status: 401, body: `bad key ${KEY}` }])
    const err = await chat(cfg(), { messages: [] }, f.fn).catch(e => e)
    expect(err.code).toBe('auth')
    expect(err.message).not.toContain(KEY)
  })
})
