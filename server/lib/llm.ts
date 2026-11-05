import type { ZodType } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider, LlmSettings, StrongLlmSettings } from '../db/schema'
import { config } from './config'
import { meterCheck, meterOwnKeyError, meterRecord } from './llm-meter'
import { decryptSecret, encryptSecret } from './secret'
import { assertPublicHost, checksActive } from './site'

export type Provider = LlmProvider

export interface ProviderPreset {
  baseUrl: string
  model: string
  modelFast: string
  needsKey: boolean
  priceInEur: number
  priceOutEur: number
  noThink?: Record<string, unknown>
  strongModel?: string
  writerModel?: string
}

const QWEN_NO_THINK = { chat_template_kwargs: { enable_thinking: false } }

export const PRESETS: Record<Provider, ProviderPreset> = {
  phala: { baseUrl: 'https://inference.phala.com/v1', model: 'qwen/qwen3.8-27b', modelFast: 'qwen/qwen3.8-27b', needsKey: true, priceInEur: 0.18, priceOutEur: 2.2, noThink: QWEN_NO_THINK, strongModel: 'z-ai/glm-5.3' },
  near: { baseUrl: 'https://cloud-api.near.ai/v1', model: 'Qwen/Qwen3.8-27B', modelFast: 'Qwen/Qwen3.8-27B', needsKey: true, priceInEur: 0.4, priceOutEur: 2.9, noThink: QWEN_NO_THINK },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', model: 'qwen-3.8-27b', modelFast: 'qwen-3.8-27b', needsKey: true, priceInEur: 0.88, priceOutEur: 1.3 },
  scaleway: { baseUrl: 'https://api.scaleway.ai/v1', model: 'qwen3.8-27b', modelFast: 'qwen3.8-27b', needsKey: true, priceInEur: 0.6, priceOutEur: 3.3, strongModel: 'mistral-medium-3.5-128b' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', modelFast: 'qwen3:8b', needsKey: false, priceInEur: 0, priceOutEur: 0 },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-medium-3-5', modelFast: 'mistral-medium-3-5', needsKey: true, priceInEur: 1.32, priceOutEur: 6.6, strongModel: 'mistral-large-4-0' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5', modelFast: 'claude-haiku-5-5', needsKey: true, priceInEur: 0.088, priceOutEur: 0.44, strongModel: 'claude-sonnet-5-5', writerModel: 'claude-opus-5-5' },
  custom: { baseUrl: '', model: '', modelFast: '', needsKey: false, priceInEur: 0, priceOutEur: 0 },
}

export const DEFAULT_PROVIDER: Provider = 'phala'

export const STRONG_PROVIDERS: Provider[] = ['mistral', 'scaleway', 'phala', 'custom', 'anthropic']

export const DEFAULT_STRONG_PROVIDER: Provider = 'mistral'

export const PROVIDER_REGION: Record<Provider, 'eu' | 'tee' | 'us' | 'local' | 'other'> = {
  mistral: 'eu',
  scaleway: 'eu',
  phala: 'tee',
  near: 'tee',
  cerebras: 'us',
  anthropic: 'us',
  ollama: 'local',
  custom: 'other',
}

// Eigener KI-Schlüssel (gehostet): feste Anbieter mit fester Adresse, keine frei wählbare URL (SSRF-Schutz).
// wire: welcher Protokoll-Zweig in chat() gilt (anthropic = native API, custom = OpenAI-kompatibel ohne Sonderfälle).
export type OwnProvider = 'mistral' | 'scaleway' | 'phala' | 'near' | 'openai' | 'anthropic' | 'openrouter'

export interface OwnProviderDef {
  baseUrl: string
  model: string
  modelFast: string
  region: 'eu' | 'tee' | 'us'
  wire: Provider
  writerModel?: string
}

export const OWN_PROVIDERS: Record<OwnProvider, OwnProviderDef> = {
  mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-medium-3-5', modelFast: 'mistral-small-latest', region: 'eu', wire: 'mistral' },
  scaleway: { baseUrl: 'https://api.scaleway.ai/v1', model: 'mistral-medium-3.5-128b', modelFast: 'qwen3.8-27b', region: 'eu', wire: 'scaleway' },
  phala: { baseUrl: 'https://inference.phala.com/v1', model: 'z-ai/glm-5.3', modelFast: 'qwen/qwen3.8-27b', region: 'tee', wire: 'phala' },
  near: { baseUrl: 'https://cloud-api.near.ai/v1', model: 'Qwen/Qwen3.8-27B', modelFast: 'Qwen/Qwen3.8-27B', region: 'tee', wire: 'near' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', modelFast: 'gpt-5-mini', region: 'us', wire: 'custom' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', modelFast: 'claude-haiku-5-5', region: 'us', wire: 'anthropic', writerModel: 'claude-opus-5-5' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.3', modelFast: 'qwen/qwen3.8-27b', region: 'us', wire: 'custom' },
}

export function isOwnProvider(p: unknown): p is OwnProvider {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(OWN_PROVIDERS, p)
}

// Denkende Modelle brauchen Platz zum Nachdenken, sonst kommt nichts zurück. Mit eigenem Schlüssel zahlt der Kunde selbst.
export const OWN_MIN_TOKENS = 8000
export const OWN_MAX_TOKENS = 32000
export const OWN_TIMEOUT_MS = 240_000

export type LlmRole = 'standard' | 'stark'

export type LlmStep = 'draft_social' | 'briefing' | 'thread_query' | 'assistant' | 'strategy' | 'weekly_review' | 'thread_relevance' | 'draft_check' | 'draft_article' | 'translate' | 'task_chat' | 'document_digest'

export const STEP_ROLES: Record<LlmStep, LlmRole> = {
  draft_social: 'standard',
  briefing: 'standard',
  thread_query: 'standard',
  assistant: 'standard',
  strategy: 'stark',
  weekly_review: 'stark',
  thread_relevance: 'stark',
  draft_check: 'stark',
  draft_article: 'stark',
  translate: 'stark',
  task_chat: 'stark',
  document_digest: 'standard',
}

export const USD_EUR = 0.88

const MODEL_PRICES_USD: Record<string, [number, number]> = {
  'qwen/qwen3.8-27b': [0.2, 2.5],
  'qwen/qwen3.5-397b-a17b': [0.55, 3.5],
  'z-ai/glm-5.3': [1.4, 4.4],
  'z-ai/glm-5.2': [1.26, 3],
  'moonshotai/kimi-k3': [3, 15],
  'moonshotai/kimi-k2.6': [1.09, 4.6],
  'deepseek/deepseek-v4-flash-0731': [0.44, 1.32],
  'deepseek/deepseek-v3.2': [1, 1],
  'meta-llama/llama-3.3-70b-instruct': [2, 2],
  'openai/gpt-oss-120b': [0.15, 0.6],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-fable-5-1': [10, 50],
  'mistral-large-4-0': [1.36, 4.18],
  'mistral-large-latest': [1.36, 4.18],
  'mistral-medium-3-5': [1.5, 7.5],
  'mistral-medium-latest': [1.5, 7.5],
}

const MODEL_PRICES_EUR: Record<string, [number, number]> = {
  'qwen3.8-27b': [0.6, 3.3],
  'mistral-medium-3.5-128b': [1.5, 7.5],
  'qwen3.5-397b-a17b': [0.6, 3.6],
  'qwen3-235b-a22b-instruct-2507': [0.75, 2.25],
  'glm-5.2': [1.8, 5.5],
  'llama-3.3-70b-instruct': [0.9, 0.9],
  'gpt-oss-120b': [0.15, 0.6],
  'deepseek-v4-flash-0731': [0.4, 0.8],
}

// Teurere Stufe für lange Eingaben: ab so vielen Eingabe-Token je Aufruf gilt der zweite Preis.
const LONG_PROMPT_USD: Record<string, { over: number, price: [number, number] }> = {
  'claude-haiku-5-5': { over: 100_000, price: [0.5, 2.5] },
}

export function modelPrice(model: string | undefined | null, tokensIn = 0): { inEur: number, outEur: number } | null {
  const id = model?.trim().toLowerCase() ?? ''
  const eur = MODEL_PRICES_EUR[id]
  if (eur) return { inEur: eur[0], outEur: eur[1] }
  const long = LONG_PROMPT_USD[id]
  const p = long && tokensIn > long.over ? long.price : MODEL_PRICES_USD[id]
  return p ? { inEur: p[0] * USD_EUR, outEur: p[1] * USD_EUR } : null
}

export type KeySource = 'workspace' | 'env' | 'none'

export interface LlmConfig {
  provider: Provider
  baseUrl: string
  apiKey: string
  keySource: KeySource
  model: string
  modelFast: string
  reasoning: boolean
  timeoutMs: number
  priceInEur: number
  priceOutEur: number
  needsKey: boolean
  role?: LlmRole
  fallback?: LlmConfig
  own?: boolean
  ownProvider?: OwnProvider
  blocked?: string
}

type EnvLlm = typeof config.llm

export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local') || h === 'host.docker.internal' || h === 'ollama'
  }
  catch {
    return false
  }
}

const PRESET_URLS = () => new Set([...Object.values(PRESETS), ...Object.values(OWN_PROVIDERS)].map(p => normUrl(p.baseUrl)).filter(u => !isLocalUrl(u)))

export async function llmUrlError(url: string): Promise<string | null> {
  const u = normUrl(url)
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) return 'Endpunkt muss mit http:// oder https:// beginnen'
  if (u === normUrl(config.llm.baseUrl) || u === normUrl(config.llmEu.baseUrl) || PRESET_URLS().has(u)) return null
  if (!config.hosted && isLocalUrl(u)) return null
  if (!config.hosted && !checksActive()) return null
  try {
    await assertPublicHost(u, { force: true })
    return null
  }
  catch (err) {
    return `Endpunkt nicht erlaubt: ${(err as Error).message}`
  }
}

export function normUrl(url: string | undefined | null): string {
  return (url ?? '').trim().replace(/\/+$/, '')
}

export function providerFromUrl(url: string): Provider {
  if (!url) return DEFAULT_PROVIDER
  if (url.includes('phala')) return 'phala'
  if (url.includes('near.ai')) return 'near'
  if (url.includes('cerebras')) return 'cerebras'
  if (url.includes('scaleway')) return 'scaleway'
  if (url.includes('anthropic.com')) return 'anthropic'
  if (url.includes('mistral.ai')) return 'mistral'
  if (url.includes(':11434')) return 'ollama'
  return 'custom'
}

function providerOf(settings: LlmSettings | undefined, env: EnvLlm): Provider {
  const p = settings?.provider
  if (p && p in PRESETS) return p as Provider
  if (p) return 'custom'
  return providerFromUrl(env.baseUrl)
}

function keyContext(workspaceId: string, baseUrl: string): string {
  return `llm-key|${workspaceId}|${normUrl(baseUrl)}`
}

export function envKeyUrl(env: EnvLlm = config.llm): string {
  return normUrl(env.baseUrl) || PRESETS[DEFAULT_PROVIDER].baseUrl
}

export function effectiveBaseUrl(settings: LlmSettings | undefined, env: EnvLlm = config.llm): string {
  const provider = providerOf(settings, env)
  const envMatches = !!env.baseUrl && providerFromUrl(env.baseUrl) === provider
  return normUrl(settings?.baseUrl || (envMatches || provider === 'custom' ? env.baseUrl : '') || PRESETS[provider].baseUrl)
}

export function storedKey(settings: LlmSettings | undefined, workspaceId: string, baseUrl: string): { key: string | null, unreadable: boolean } {
  const k = settings?.key
  if (!k || normUrl(k.baseUrl) !== normUrl(baseUrl)) return { key: null, unreadable: false }
  const key = decryptSecret(k.enc, keyContext(workspaceId, baseUrl))
  return { key, unreadable: !key }
}

export function llmLocked(): boolean {
  return config.llmSettingsLocked
}

export function llmConfig(settings: LlmSettings | undefined, env: EnvLlm = config.llm, workspaceId = ''): LlmConfig {
  if (llmLocked()) settings = undefined
  const provider = providerOf(settings, env)
  const preset = PRESETS[provider]
  const envMatches = !!env.baseUrl && providerFromUrl(env.baseUrl) === provider
  const baseUrl = effectiveBaseUrl(settings, env)
  const model = settings?.model || (envMatches || provider === 'custom' ? env.model : '') || preset.model
  let apiKey = ''
  let keySource: KeySource = 'none'
  const ws = storedKey(settings, workspaceId, baseUrl)
  if (ws.key) {
    apiKey = ws.key
    keySource = 'workspace'
  }
  else if (env.apiKey && baseUrl && baseUrl === envKeyUrl(env)) {
    apiKey = env.apiKey
    keySource = 'env'
  }
  return {
    provider,
    baseUrl,
    apiKey,
    keySource,
    model,
    modelFast: settings?.modelFast || (envMatches ? env.modelFast : '') || preset.modelFast || model,
    reasoning: settings?.reasoning ?? false,
    timeoutMs: env.timeoutMs,
    priceInEur: Number(process.env.LLM_PRICE_IN_EUR ?? modelPrice(model)?.inEur ?? preset.priceInEur),
    priceOutEur: Number(process.env.LLM_PRICE_OUT_EUR ?? modelPrice(model)?.outEur ?? preset.priceOutEur),
    needsKey: preset.needsKey || (provider === 'custom' && !!baseUrl && !isLocalUrl(baseUrl)),
  }
}

function strongKeyContext(workspaceId: string, baseUrl: string): string {
  return `llm-strong-key|${workspaceId}|${normUrl(baseUrl)}`
}

function strongProvider(s: StrongLlmSettings | undefined): Provider {
  const p = s?.provider
  return p && p in PRESETS && p !== 'ollama' ? p : p ? 'custom' : DEFAULT_STRONG_PROVIDER
}

export function strongBaseUrl(s: StrongLlmSettings | undefined): string {
  return normUrl(s?.baseUrl || PRESETS[strongProvider(s)].baseUrl)
}

export function storedStrongKey(s: StrongLlmSettings | undefined, workspaceId: string): { key: string | null, unreadable: boolean } {
  const k = s?.key
  const url = strongBaseUrl(s)
  if (!k || normUrl(k.baseUrl) !== url) return { key: null, unreadable: false }
  const key = decryptSecret(k.enc, strongKeyContext(workspaceId, url))
  return { key, unreadable: !key }
}

export function strongLlmConfig(settings: LlmSettings | undefined, env: EnvLlm = config.llm, workspaceId = '', ignoreEnabled = false): LlmConfig | null {
  const s = settings?.strong
  if (llmLocked() || !s || (!s.enabled && !ignoreEnabled)) return null
  const provider = strongProvider(s)
  const preset = PRESETS[provider]
  const baseUrl = strongBaseUrl(s)
  const model = s.model?.trim() || preset.strongModel || preset.model
  let apiKey = ''
  let keySource: KeySource = 'none'
  const own = storedStrongKey(s, workspaceId)
  if (own.key) {
    apiKey = own.key
    keySource = 'workspace'
  }
  else {
    const std = llmConfig(settings, env, workspaceId)
    if (std.apiKey && std.baseUrl === baseUrl) {
      apiKey = std.apiKey
      keySource = std.keySource
    }
  }
  const price = modelPrice(model)
  return {
    provider,
    baseUrl,
    apiKey,
    keySource,
    model,
    modelFast: model,
    reasoning: false,
    timeoutMs: Math.max(env.timeoutMs, 180_000),
    priceInEur: price?.inEur ?? (provider === 'custom' ? 0 : preset.priceInEur),
    priceOutEur: price?.outEur ?? (provider === 'custom' ? 0 : preset.priceOutEur),
    needsKey: preset.needsKey || (provider === 'custom' && !!baseUrl && !isLocalUrl(baseUrl)),
    role: 'stark',
  }
}

export function llmForStep(settings: LlmSettings | undefined, step: LlmStep, env: EnvLlm = config.llm, workspaceId = ''): LlmConfig {
  const std = { ...llmConfig(settings, env, workspaceId), role: 'standard' as const }
  if (STEP_ROLES[step] !== 'stark') return std
  const strong = strongLlmConfig(settings, env, workspaceId)
  if (!strong || !llmStatus(strong).configured) return std
  return llmStatus(std).configured ? { ...strong, fallback: std } : strong
}

// Lange kreative Texte (Blog-Artikel) schreibt das beste Modell des Anbieters (Anthropic: Opus), mit dem Standardmodell als Ausweich.
// LLM_MODEL_WRITER ersetzt die Vorgabe (gleich LLM_MODEL = aus). Eigener Schlüssel: nur, solange dort das vorgegebene Modell steht.
// Eingestelltes starkes Modell oder Tarif ohne starkes Modell: bleibt, wie es ist.
export function writerFrom(base: LlmConfig, strongAllowed = true, writerModel = config.llmWriterModel): LlmConfig {
  if (base.blocked || base.role === 'stark' || (!base.own && !strongAllowed)) return base
  const own = base.own && base.ownProvider ? OWN_PROVIDERS[base.ownProvider] : null
  if (base.own && own?.model !== base.model) return base
  const model = own ? own.writerModel : (base.keySource === 'env' ? writerModel.trim() : '') || PRESETS[base.provider]?.writerModel
  if (!model || model === base.model || (!base.apiKey && base.needsKey)) return base
  const price = modelPrice(model)
  return { ...base, model, modelFast: model, role: 'stark', reasoning: false, timeoutMs: Math.max(base.timeoutMs, OWN_TIMEOUT_MS), priceInEur: price?.inEur ?? base.priceInEur, priceOutEur: price?.outEur ?? base.priceOutEur, fallback: base }
}

// EU-Modus je Workspace: nur ein EU-Anbieter (Mistral, Scaleway) aus LLM_EU_*, nie ein Rückfall auf die Standard-KI.
export function euAvailable(env: EnvLlm = config.llmEu): boolean {
  return !!env.baseUrl && !!env.model && PROVIDER_REGION[providerFromUrl(env.baseUrl)] === 'eu' && llmStatus(llmConfig(undefined, env)).configured
}

export function euProvider(env: EnvLlm = config.llmEu): Provider | null {
  return euAvailable(env) ? providerFromUrl(env.baseUrl) : null
}

export function euLlmForStep(settings: LlmSettings | undefined, step: LlmStep | undefined, workspaceId = '', env: EnvLlm = config.llmEu): LlmConfig {
  const base = llmConfig(undefined, env, workspaceId)
  const std: LlmConfig = euAvailable(env) ? { ...base, role: 'standard' } : { ...base, baseUrl: '', role: 'standard' }
  if (!step || STEP_ROLES[step] !== 'stark' || !llmStatus(std).configured) return std
  const strong = strongLlmConfig(settings, env, workspaceId)
  if (!strong || PROVIDER_REGION[strong.provider] !== 'eu' || !llmStatus(strong).configured) return std
  return { ...strong, fallback: std }
}

export interface StrongUpdate {
  enabled?: boolean
  provider?: Provider
  baseUrl?: string
  model?: string
  apiKey?: string
  removeKey?: boolean
}

export function applyStrongUpdate(current: StrongLlmSettings | undefined, input: StrongUpdate, workspaceId: string, at = new Date()): StrongLlmSettings {
  const { apiKey, removeKey, ...rest } = input
  const next: StrongLlmSettings = { ...current, ...rest }
  if (rest.baseUrl !== undefined) next.baseUrl = normUrl(rest.baseUrl)
  if (rest.model !== undefined) next.model = rest.model.trim()
  const before = strongBaseUrl(current)
  const after = strongBaseUrl(next)
  if (removeKey || before !== after || (next.key && normUrl(next.key.baseUrl) !== after)) delete next.key
  const k = apiKey?.trim()
  if (k) next.key = { enc: encryptSecret(k, strongKeyContext(workspaceId, after)), hint: keyHint(k), baseUrl: after, setAt: at.toISOString() }
  return next
}

export interface LlmUpdate {
  provider?: Provider
  baseUrl?: string
  model?: string
  modelFast?: string
  reasoning?: boolean
  apiKey?: string
  removeKey?: boolean
}

export function keyHint(key: string): string {
  return key.length > 8 ? key.slice(-4) : ''
}

export function applyLlmUpdate(current: LlmSettings | undefined, input: LlmUpdate, workspaceId: string, env: EnvLlm = config.llm, at = new Date()): LlmSettings {
  const { apiKey, removeKey, ...rest } = input
  const next: LlmSettings = { ...current, ...rest }
  if (next.provider === 'openai') next.provider = 'custom'
  if (rest.baseUrl !== undefined) next.baseUrl = normUrl(rest.baseUrl)
  const before = effectiveBaseUrl(current, env)
  const after = effectiveBaseUrl(next, env)
  if (removeKey || before !== after || (next.key && normUrl(next.key.baseUrl) !== after)) delete next.key
  const k = apiKey?.trim()
  if (k) next.key = { enc: encryptSecret(k, keyContext(workspaceId, after)), hint: keyHint(k), baseUrl: after, setAt: at.toISOString() }
  return next
}

export function publicLlmSettings(settings: LlmSettings | undefined): Omit<LlmSettings, 'key' | 'strong'> {
  const { key: _key, strong: _strong, ...rest } = settings ?? {}
  return rest
}

export interface LlmStatus {
  configured: boolean
  reason: 'ok' | 'no_key' | 'no_url' | 'no_model'
}

export function llmStatus(cfg: LlmConfig): LlmStatus {
  if (!cfg.baseUrl) return { configured: false, reason: 'no_url' }
  if (!cfg.model) return { configured: false, reason: 'no_model' }
  if (cfg.needsKey && !cfg.apiKey) return { configured: false, reason: 'no_key' }
  return { configured: true, reason: 'ok' }
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

function wireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId }
  if (m.role === 'assistant' && m.toolCalls?.length) return { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) }
  return { role: m.role, content: m.content }
}

export interface ChatOptions {
  messages: ChatMessage[]
  fast?: boolean
  temperature?: number
  maxTokens?: number
  reasoning?: boolean
  tools?: ToolDef[]
}

export interface ChatResult {
  content: string
  model: string
  note?: string
  tokensIn: number
  tokensOut: number
  costEur: number
  toolCalls: ToolCall[]
  own?: boolean
}

export type LlmErrorCode = 'auth' | 'not_found' | 'rate' | 'network' | 'empty' | 'not_configured' | 'other'

export type OwnKeyProblem = 'auth' | 'quota' | 'model'

export class LlmError extends Error {
  ownKey?: OwnKeyProblem
  constructor(message: string, public status = 0, public code: LlmErrorCode = 'other') {
    super(message)
  }
}

const QUOTA_TEXT = /quota|credit|billing|balance|insufficient|payment|exceeded your current/i

// Fehler, die mit dem eigenen Schlüssel nicht von selbst verschwinden: abgelehnt, Guthaben leer, Modell unbekannt.
export function ownKeyProblem(status: number, text: string): OwnKeyProblem | null {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'quota'
  if ((status === 429 || status === 400) && QUOTA_TEXT.test(text)) return 'quota'
  if (status === 404 || (status === 400 && /model.{0,40}(not found|not exist|invalid|unknown)|model_not_found|invalid model/i.test(text))) return 'model'
  return null
}

export class LlmNotConfiguredError extends LlmError {
  constructor(message: string) {
    super(message, 0, 'not_configured')
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const MIN_TOKENS = 256
const noThinkRejected = new Set<string>()

export function redactKey(text: string, key: string): string {
  let out = key ? text.split(key).join('***') : text
  out = out.replace(/\b(sk|pk|key|api|scw|csk|nearai)[-_][A-Za-z0-9_-]{8,}/gi, '***')
  return out.replace(/[A-Za-z0-9_-]{32,}/g, '***')
}

function codeFor(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate'
  return 'other'
}

// Mistral (denkende Modelle) liefert content als Liste von Teilen: {type:'thinking'} und {type:'text', text}
type WireContent = string | null | { type?: string, text?: string }[]

export function wireText(c: WireContent | undefined): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('')
}

function wireThought(c: WireContent | undefined): boolean {
  if (typeof c === 'string') return /<think>/.test(c)
  return Array.isArray(c) && c.some(p => p?.type === 'thinking')
}

interface WireResponse {
  model?: string
  choices?: { finish_reason?: string | null, message?: { content?: WireContent, reasoning_content?: string | null, reasoning?: string | null, tool_calls?: { id?: string, function?: { name?: string, arguments?: string | Record<string, unknown> } }[] } }[]
  usage?: { prompt_tokens?: number, completion_tokens?: number, cost?: number }
}

function shortReason(err: unknown): string {
  if (err instanceof LlmError) {
    if (err.status) return `HTTP ${err.status}`
    if (err.code === 'network') return /abort/i.test(err.message) ? 'Zeitüberschreitung' : 'nicht erreichbar'
    if (err.code === 'empty') return 'leere Antwort'
    if (err.code === 'not_configured') return 'nicht eingerichtet'
  }
  return 'Fehler'
}

export async function chat(cfg: LlmConfig, opts: ChatOptions, fetchImpl: FetchLike = fetch, maxTries = 4, maxWaitSec = 20): Promise<ChatResult> {
  await meterCheck(!!cfg.own)
  if (cfg.own) maxTries = Math.min(maxTries, 3)
  try {
    const res = await chatWithFallback(cfg, opts, fetchImpl, maxTries, maxWaitSec)
    if (cfg.own) res.own = true
    meterRecord(res)
    return res
  }
  catch (err) {
    const usage = (err as { usage?: ChatResult | ChatResult[] }).usage
    if (cfg.own && usage) for (const u of Array.isArray(usage) ? usage : [usage]) u.own = true
    meterRecord(usage)
    if (cfg.own && err instanceof LlmError) {
      err.message = redactKey(err.message, cfg.apiKey)
      if (err.ownKey) meterOwnKeyError(err)
    }
    throw err
  }
}

async function chatWithFallback(cfg: LlmConfig, opts: ChatOptions, fetchImpl: FetchLike, maxTries: number, maxWaitSec: number): Promise<ChatResult> {
  if (!cfg.fallback) return chatOnce(cfg, opts, fetchImpl, maxTries, maxWaitSec)
  try {
    return await chatOnce(cfg, opts, fetchImpl, Math.min(maxTries, 2), Math.min(maxWaitSec, 5))
  }
  catch (err) {
    if (!(err instanceof LlmError)) throw err
    const res = await chatOnce(cfg.fallback, opts, fetchImpl, maxTries, maxWaitSec)
    const used = (err as LlmError & { usage?: ChatResult }).usage
    const note = `Starkes Modell ${cfg.model} ausgefallen (${shortReason(err)}), Standardmodell ${res.model} verwendet`
    return used ? { ...res, tokensIn: res.tokensIn + used.tokensIn, tokensOut: res.tokensOut + used.tokensOut, costEur: res.costEur + used.costEur, note } : { ...res, note }
  }
}

function costOf(cfg: LlmConfig, model: string, tokensIn: number, tokensOut: number, reportedUsd?: number): number {
  if (typeof reportedUsd === 'number' && reportedUsd >= 0 && Number.isFinite(reportedUsd)) return reportedUsd * USD_EUR
  const envPrice = cfg.role !== 'stark' && !cfg.own
  const envIn = envPrice ? process.env.LLM_PRICE_IN_EUR : undefined
  const envOut = envPrice ? process.env.LLM_PRICE_OUT_EUR : undefined
  const p = modelPrice(model, tokensIn)
  const pin = envIn !== undefined ? Number(envIn) : p?.inEur ?? cfg.priceInEur
  const pout = envOut !== undefined ? Number(envOut) : p?.outEur ?? cfg.priceOutEur
  return (tokensIn * pin + tokensOut * pout) / 1_000_000
}

function blockedError(cfg: LlmConfig): LlmError {
  const e = new LlmError(cfg.blocked!, 0, 'auth')
  e.ownKey = 'auth'
  return e
}

function ownMaxTokens(requested: number | undefined): number {
  return Math.min(Math.max((requested ?? 2000) * 4, OWN_MIN_TOKENS), OWN_MAX_TOKENS)
}

const OPENAI_REASONING = /^(o\d|gpt-5)/i
// laut Mistral-Doku: reasoning_effort nur 'none' oder 'high', bei Small, Medium 3.5 und Large 4
const MISTRAL_REASONING = /^mistral-(small|medium|large)/i

function isMistral(cfg: LlmConfig): boolean {
  return cfg.provider === 'mistral' || cfg.ownProvider === 'mistral' || /api\.mistral\.ai/i.test(cfg.baseUrl)
}

async function chatOnce(cfg: LlmConfig, opts: ChatOptions, fetchImpl: FetchLike, maxTries: number, maxWaitSec: number): Promise<ChatResult> {
  if (cfg.own && cfg.blocked) throw blockedError(cfg)
  const st = llmStatus(cfg)
  if (!st.configured) throw new LlmNotConfiguredError(`LLM nicht konfiguriert (${st.reason})`)
  const urlError = await llmUrlError(cfg.baseUrl)
  if (urlError) throw new LlmError(urlError, 0, 'other')
  if (cfg.provider === 'anthropic') return chatAnthropic(cfg, opts, fetchImpl, maxTries)
  const model = opts.fast ? cfg.modelFast : cfg.model
  const baseTokens = Math.max(opts.maxTokens ?? 2000, MIN_TOKENS)
  const maxTokens = cfg.own ? ownMaxTokens(opts.maxTokens) : baseTokens
  const reasoning = opts.reasoning ?? cfg.reasoning
  const openaiNew = cfg.ownProvider === 'openai'
  const tokenField = openaiNew ? 'max_completion_tokens' : 'max_tokens'
  const payload: Record<string, unknown> = {
    model,
    messages: opts.messages.map(wireMessage),
    temperature: opts.temperature ?? 0.6,
    [tokenField]: maxTokens,
  }
  if (opts.tools?.length) payload.tools = opts.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  if (cfg.provider === 'scaleway') payload.reasoning_effort = reasoning ? 'medium' : 'none'
  const mistralEffort = isMistral(cfg) && MISTRAL_REASONING.test(model)
  if (mistralEffort) payload.reasoning_effort = reasoning ? 'high' : 'none'
  if (openaiNew && OPENAI_REASONING.test(model)) {
    delete payload.temperature
    payload.reasoning_effort = reasoning ? 'medium' : 'low'
  }
  if (cfg.ownProvider === 'openrouter') {
    payload.reasoning = { effort: reasoning ? 'medium' : 'low' }
    payload.usage = { include: true }
  }
  const thinkKey = `${cfg.baseUrl}|${model}`
  const noThink = !reasoning && /qwen/i.test(model) && !noThinkRejected.has(thinkKey) ? PRESETS[cfg.provider]?.noThink : undefined
  if (noThink) Object.assign(payload, noThink)
  Object.assign(payload, extraBody())
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  let lastErr: LlmError | null = null
  let grown = false
  let droppedNoThink = false
  let droppedEffort = false
  let shrunk = false
  let tokensInSum = 0
  let tokensOutSum = 0
  let reportedUsd: number | undefined
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
    let res: Response
    try {
      res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal })
    }
    catch (err) {
      clearTimeout(timer)
      lastErr = new LlmError(`Verbindung fehlgeschlagen: ${redactKey((err as Error).message, cfg.apiKey)}`, 0, 'network')
      if (attempt < maxTries) await sleep(Math.min(maxWaitSec, 2 ** attempt) * 1000)
      continue
    }
    clearTimeout(timer)
    if (res.ok) {
      const data = await res.json() as WireResponse
      const choice = data.choices?.[0]
      const msg = choice?.message
      const content = stripThinking(wireText(msg?.content))
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).filter(t => t.function?.name).map((t, i) => ({
        id: t.id || `call_${Date.now()}_${i}`,
        name: t.function!.name!,
        arguments: typeof t.function!.arguments === 'string' ? t.function!.arguments : JSON.stringify(t.function!.arguments ?? {}),
      }))
      tokensInSum += data.usage?.prompt_tokens ?? 0
      tokensOutSum += data.usage?.completion_tokens ?? 0
      if (typeof data.usage?.cost === 'number') reportedUsd = (reportedUsd ?? 0) + data.usage.cost
      if (!content && !toolCalls.length) {
        const thought = !!(msg?.reasoning_content || msg?.reasoning || wireThought(msg?.content))
        if (!grown && (thought || choice?.finish_reason === 'length')) {
          grown = true
          payload[tokenField] = cfg.own ? OWN_MAX_TOKENS : Math.max(maxTokens * 3, 4000)
          attempt--
          continue
        }
        const e = new LlmError(thought ? 'Antwort war leer (Modell hat nur nachgedacht)' : 'Antwort war leer', 0, 'empty') as LlmError & { usage?: ChatResult }
        e.usage = { content: '', model, tokensIn: tokensInSum, tokensOut: tokensOutSum, costEur: costOf(cfg, model, tokensInSum, tokensOutSum, reportedUsd), toolCalls: [] }
        throw e
      }
      const used = data.model ?? model
      return { content, model: used, tokensIn: tokensInSum, tokensOut: tokensOutSum, costEur: costOf(cfg, used, tokensInSum, tokensOutSum, reportedUsd), toolCalls }
    }
    const text = redactKey(await res.text().catch(() => ''), cfg.apiKey)
    if (noThink && !droppedNoThink && (res.status === 400 || res.status === 422)) {
      droppedNoThink = true
      noThinkRejected.add(thinkKey)
      for (const k of Object.keys(noThink)) delete payload[k]
      attempt--
      continue
    }
    if (mistralEffort && !droppedEffort && (res.status === 400 || res.status === 422) && /reasoning/i.test(text)) {
      droppedEffort = true
      delete payload.reasoning_effort
      attempt--
      continue
    }
    if (cfg.own && !shrunk && (res.status === 400 || res.status === 422) && /max_(completion_)?tokens|max.?output|too large|maximum/i.test(text)) {
      shrunk = true
      payload[tokenField] = baseTokens
      attempt--
      continue
    }
    lastErr = new LlmError(`HTTP ${res.status}: ${redactKey(text.slice(0, 300), cfg.apiKey)}`, res.status, codeFor(res.status))
    const problem = cfg.own ? ownKeyProblem(res.status, text) : null
    if (problem) {
      lastErr.ownKey = problem
      break
    }
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500
    if (!retryable || attempt === maxTries) break
    const ra = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, maxWaitSec) : Math.min(maxWaitSec, 2 ** (attempt + 1))
    await sleep(wait * 1000)
  }
  throw lastErr ?? new LlmError('Unbekannter Fehler')
}

const ANTHROPIC_MAX_TOKENS = 32000

const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])

type AnthropicMessage = Anthropic.Beta.BetaMessageParam

export function anthropicMessages(messages: ChatMessage[]): { system: string, messages: AnthropicMessage[] } {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const out: AnthropicMessage[] = []
  const push = (role: 'user' | 'assistant', block: Anthropic.Beta.BetaContentBlockParam) => {
    const last = out.at(-1)
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(block)
    else out.push({ role, content: [block] })
  }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      push('user', { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content || '-' })
      continue
    }
    if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content })
      for (const t of m.toolCalls ?? []) {
        let input: unknown = {}
        try {
          input = JSON.parse(t.arguments || '{}')
        }
        catch {
          input = {}
        }
        push('assistant', { type: 'tool_use', id: t.id, name: t.name, input: input && typeof input === 'object' ? input : {} })
      }
      continue
    }
    push('user', { type: 'text', text: m.content || '-' })
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '-' }] })
  return { system, messages: out }
}

async function chatAnthropic(cfg: LlmConfig, opts: ChatOptions, fetchImpl: FetchLike, maxTries: number): Promise<ChatResult> {
  const model = opts.fast ? cfg.modelFast : cfg.model
  const reasoning = opts.reasoning ?? cfg.reasoning
  const maxTokens = cfg.own ? ownMaxTokens(opts.maxTokens) : Math.max(opts.maxTokens ?? 2000, MIN_TOKENS)
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, fetch: fetchImpl as typeof fetch, maxRetries: Math.max(0, maxTries - 1), timeout: cfg.timeoutMs })
  const { system, messages } = anthropicMessages(opts.messages)
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: Math.min(maxTokens * 2 + (reasoning ? 8000 : 4000), ANTHROPIC_MAX_TOKENS),
    messages,
    output_config: { effort: reasoning ? 'high' : 'low' },
  }
  if (system) params.system = system
  if (opts.tools?.length) params.tools = opts.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema }))
  if (ANTHROPIC_FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01']
    params.fallbacks = 'default'
  }
  let tokensIn = 0
  let tokensOut = 0
  let costEur = 0
  for (let grow = 0; ; grow++) {
    let res: Anthropic.Beta.BetaMessage
    try {
      res = await client.beta.messages.create(params, grow ? { timeout: Math.max(cfg.timeoutMs, OWN_TIMEOUT_MS) } : undefined)
    }
    catch (err) {
      const e = anthropicError(err, cfg) as LlmError & { usage?: ChatResult }
      if (tokensIn) e.usage = { content: '', model, tokensIn, tokensOut, costEur, toolCalls: [] }
      throw e
    }
    const content = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map(b => b.text).join('').trim()
    const toolCalls: ToolCall[] = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }))
    const u = res.usage
    const callIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const callOut = u.output_tokens ?? 0
    tokensIn += callIn
    tokensOut += callOut
    costEur += costOf(cfg, res.model ?? model, callIn, callOut)
    const result: ChatResult = { content, model: res.model ?? model, tokensIn, tokensOut, costEur, toolCalls }
    // Denkende Modelle (z.B. Haiku 5.5) verbrauchen Token fürs Nachdenken: abgeschnitten, dann einmal mit mehr Platz.
    if (res.stop_reason === 'max_tokens' && !toolCalls.length && grow === 0 && params.max_tokens < ANTHROPIC_MAX_TOKENS) {
      params.max_tokens = ANTHROPIC_MAX_TOKENS
      continue
    }
    if (res.stop_reason === 'refusal' || (!content && !toolCalls.length)) {
      const e = new LlmError(res.stop_reason === 'refusal' ? 'Modell hat abgelehnt' : res.stop_reason === 'max_tokens' ? 'Antwort war leer (Modell hat nur nachgedacht)' : 'Antwort war leer', 0, 'empty') as LlmError & { usage?: ChatResult }
      e.usage = result
      throw e
    }
    return result
  }
}

function anthropicError(err: unknown, cfg: LlmConfig): LlmError {
  if (err instanceof Anthropic.APIConnectionError) return new LlmError(`Verbindung fehlgeschlagen: ${redactKey(err.message, cfg.apiKey)}`, 0, 'network')
  if (err instanceof Anthropic.APIError) {
    const e = new LlmError(`HTTP ${err.status ?? 0}: ${redactKey(String(err.message).slice(0, 300), cfg.apiKey)}`, err.status ?? 0, codeFor(err.status ?? 0))
    if (cfg.own) e.ownKey = ownKeyProblem(err.status ?? 0, String(err.message)) ?? undefined
    return e
  }
  return new LlmError(redactKey((err as Error).message, cfg.apiKey))
}

function extraBody(): Record<string, unknown> {
  const raw = process.env.LLM_EXTRA_BODY
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

export function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*<think>[\s\S]*$/, '').trim()
}

// Kandidaten in fester Reihenfolge: ganzer Text, äußerer Codeblock, Objekt vom ersten { bis zum letzten }, sonstige Codeblöcke.
// Codeblöcke im Text (z.B. Snippets in einem Artikel) dürfen das eigentliche JSON nicht verdecken.
export function extractJson(s: string): unknown {
  const text = s.trim()
  const candidates: string[] = [text]
  const outer = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text)
  if (outer) candidates.push(outer[1]!)
  for (const base of [outer ? outer[1]! : text, text]) {
    const start = base.search(/[{[]/)
    if (start < 0) continue
    const end = base.lastIndexOf(base[start] === '{' ? '}' : ']')
    if (end > start) candidates.push(base.slice(start, end + 1))
  }
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = m[1]!.trim()
    if (/^[{[]/.test(inner)) candidates.push(inner)
  }
  let firstError: Error | null = null
  for (const c of [...new Set(candidates)]) {
    if (!/^[{[]/.test(c)) continue
    try {
      return JSON.parse(c)
    }
    catch (err) {
      try {
        return JSON.parse(escapeControlInStrings(c))
      }
      catch {
        firstError ??= err as Error
      }
    }
  }
  if (firstError) throw firstError
  throw new Error(/[{[]/.test(text) ? 'JSON unvollständig' : 'Kein JSON gefunden')
}

export function escapeControlInStrings(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) {
        esc = false
        out += ch
        continue
      }
      if (ch === '\\') {
        esc = true
        out += ch
        continue
      }
      if (ch === '"') inStr = false
      else if (ch === '\n') {
        out += '\\n'
        continue
      }
      else if (ch === '\r') continue
      else if (ch === '\t') {
        out += '\\t'
        continue
      }
    }
    else if (ch === '"') {
      inStr = true
    }
    out += ch
  }
  return out
}

export async function chatJson<T>(cfg: LlmConfig, opts: ChatOptions, schema: ZodType<T>, fetchImpl: FetchLike = fetch): Promise<{ data: T, usage: ChatResult[] }> {
  const usage: ChatResult[] = []
  const first = await chat(cfg, opts, fetchImpl)
  usage.push(first)
  const tryParse = (c: string) => {
    try {
      const r = schema.safeParse(extractJson(c))
      return r.success ? { ok: true as const, data: r.data } : { ok: false as const, error: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
    }
    catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  }
  const p1 = tryParse(first.content)
  if (p1.ok) return { data: p1.data, usage }
  const repair = await chat(cfg, {
    ...opts,
    messages: [...opts.messages, { role: 'assistant', content: first.content }, { role: 'user', content: `Die Antwort war kein gültiges JSON nach Vorgabe (${p1.error}). Antworte jetzt nur mit dem korrigierten JSON-Objekt, ohne weiteren Text.` }],
  }, fetchImpl)
  usage.push(repair)
  const p2 = tryParse(repair.content)
  if (p2.ok) return { data: p2.data, usage }
  // Reparatur gescheitert: einmal frisch mit klarem Hinweis anfragen statt den Job abzubrechen.
  const retry = await chat(cfg, {
    ...opts,
    messages: [...opts.messages, { role: 'user', content: `Wichtig: Antworte ausschließlich mit genau einem gültigen JSON-Objekt, beginnend mit { und endend mit }, ohne Text davor oder danach und ohne Codeblock drumherum. Zeilenumbrüche, Anführungszeichen und Codeblöcke innerhalb von Textfeldern korrekt escapen (\\n, \\"). Letzter Fehler: ${p2.error}` }],
  }, fetchImpl)
  usage.push(retry)
  const p3 = tryParse(retry.content)
  if (p3.ok) return { data: p3.data, usage }
  const err = new LlmError(`Ungültiges JSON nach Reparatur: ${p3.error}`) as LlmError & { usage?: ChatResult[] }
  err.usage = usage
  throw err
}
