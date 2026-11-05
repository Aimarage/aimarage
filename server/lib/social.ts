import type { StoredLlmKey, WorkspaceSettings } from '../db/schema'
import { keyHint, redactKey } from './llm'
import { config, envValue } from './config'
import { OWN_PROVIDERS, publicApps, publicConnections } from './connections'
import { defaultRedirect, OAUTH_PROVIDERS } from './platforms/oauth'
import { looksHtml, statusText } from './platforms/types'
import { decryptSecret, encryptSecret } from './secret'

export type SocialProvider = 'zernio' | 'uploadpost'

export interface SocialPreset {
  label: string
  baseUrl: string
  envKeys: string[]
  auth: (key: string) => string
  accountsPath: string
}

export const SOCIAL_PROVIDERS: Record<SocialProvider, SocialPreset> = {
  uploadpost: { label: 'Upload-Post (US-Dienst)', baseUrl: 'https://api.upload-post.com/api', envKeys: ['UPLOAD_POST_API_KEY', 'UPLOADPOST_API_KEY'], auth: k => `Apikey ${k}`, accountsPath: '/uploadposts/users' },
  zernio: { label: 'Zernio', baseUrl: 'https://zernio.com/api/v1', envKeys: ['ZERNIO_API_KEY'], auth: k => `Bearer ${k}`, accountsPath: '/accounts' },
}

export const DEFAULT_SOCIAL: SocialProvider = 'uploadpost'

export interface SocialProfile {
  id: string
  name: string
}

export interface SocialAccount {
  id: string
  platform: string
  name: string
  profileId: string | null
  profileName: string | null
  connectedAt?: string
}

export interface SocialSettings {
  provider?: SocialProvider
  key?: StoredLlmKey
  accounts?: SocialAccount[]
  profiles?: SocialProfile[]
  checkedAt?: string
  hosted?: { profileId: string, at: string }
}

export interface ProjectSocial {
  profileIds?: string[]
  accountIds?: string[]
}

export function projectAccounts(assign: ProjectSocial | null | undefined, accounts: SocialAccount[]): SocialAccount[] {
  const prof = new Set(assign?.profileIds ?? [])
  const acc = new Set(assign?.accountIds ?? [])
  return accounts.filter(a => acc.has(a.id) || (a.profileId && prof.has(a.profileId)))
}

export interface SocialConfig {
  provider: SocialProvider
  baseUrl: string
  apiKey: string
  keySource: 'workspace' | 'env' | 'hosted' | 'none'
  unreadable: boolean
  // Gehostet: Zernio-Profil des Workspace. Alle Aufrufe sind auf dieses Profil beschränkt.
  profileId?: string | null
}

function context(workspaceId: string, provider: SocialProvider): string {
  return `social-key|${workspaceId}|${SOCIAL_PROVIDERS[provider].baseUrl}`
}

export function socialEnvAllowed(settings: WorkspaceSettings | null | undefined): boolean {
  return config.socialEnvFallback || settings?.socialEnvFallback === true
}

// Gehostetes Posten: Zernio mit dem Betreiber-Schlüssel, je Workspace ein eigenes Profil (HOSTED=true und ZERNIO_API_KEY).
export function hostedZernioKey(): string {
  return config.hosted ? config.zernioApiKey : ''
}

// Konten des gehosteten Profils. Konten anderer Profile oder eines früheren Dienstes zählen nie dazu.
export function hostedAccounts(settings: SocialSettings | undefined): SocialAccount[] {
  const pid = settings?.hosted?.profileId
  return pid ? (settings?.accounts ?? []).filter(a => a.profileId === pid) : []
}

export function socialConfig(settings: SocialSettings | undefined, workspaceId: string, env?: Record<string, string | undefined>, allowEnv = config.socialEnvFallback, hostedKey = hostedZernioKey()): SocialConfig {
  const provider = settings?.provider && settings.provider in SOCIAL_PROVIDERS ? settings.provider : DEFAULT_SOCIAL
  const preset = SOCIAL_PROVIDERS[provider]
  let apiKey = ''
  let keySource: SocialConfig['keySource'] = 'none'
  let unreadable = false
  const k = settings?.key
  if (k && k.baseUrl === preset.baseUrl) {
    const plain = decryptSecret(k.enc, context(workspaceId, provider))
    if (plain) {
      apiKey = plain
      keySource = 'workspace'
    }
    else {
      unreadable = true
    }
  }
  const envBlocked = !!hostedKey && provider === 'zernio'
  const fromEnv = allowEnv && !envBlocked ? preset.envKeys.map(k => (env ? env[k] : envValue(k))).find(Boolean) : undefined
  if (!apiKey && fromEnv) {
    apiKey = fromEnv
    keySource = 'env'
  }
  if (!apiKey && hostedKey) return { provider: 'zernio', baseUrl: SOCIAL_PROVIDERS.zernio.baseUrl, apiKey: hostedKey, keySource: 'hosted', unreadable, profileId: settings?.hosted?.profileId ?? null }
  return { provider, baseUrl: preset.baseUrl, apiKey, keySource, unreadable }
}

export function applySocialUpdate(current: SocialSettings | undefined, input: { provider?: SocialProvider, apiKey?: string, removeKey?: boolean }, workspaceId: string, at = new Date()): SocialSettings {
  const next: SocialSettings = { ...current }
  const before = current?.provider ?? DEFAULT_SOCIAL
  if (input.provider) next.provider = input.provider
  const after = next.provider ?? DEFAULT_SOCIAL
  if (input.removeKey || before !== after) {
    delete next.key
    if (before !== after) {
      delete next.accounts
      delete next.profiles
      delete next.checkedAt
    }
  }
  const k = input.apiKey?.trim()
  if (k) next.key = { enc: encryptSecret(k, context(workspaceId, after)), hint: keyHint(k), baseUrl: SOCIAL_PROVIDERS[after].baseUrl, setAt: at.toISOString() }
  return next
}

export function publicSocial(ws: { id: string, settings: WorkspaceSettings | null }) {
  const s = ws.settings?.social
  const cfg = socialConfig(s, ws.id, undefined, socialEnvAllowed(ws.settings))
  return {
    provider: cfg.provider,
    providers: Object.entries(SOCIAL_PROVIDERS).map(([id, p]) => ({ id, label: p.label })),
    key: { source: cfg.keySource, hint: cfg.keySource === 'workspace' ? s?.key?.hint ?? '' : null, setAt: cfg.keySource === 'workspace' ? s?.key?.setAt ?? null : null, unreadable: cfg.unreadable },
    hosted: cfg.keySource === 'hosted',
    accounts: [...(cfg.keySource === 'hosted' ? hostedAccounts(s) : s?.accounts ?? []), ...publicConnections(ws).map(c => ({ id: c.id, platform: c.platform, name: c.name, profileId: null, profileName: null, own: true }))],
    profiles: s?.profiles ?? profilesOf(s?.accounts ?? []),
    checkedAt: s?.checkedAt ?? null,
    live: !!ws.settings?.publishLive,
    connections: publicConnections(ws),
    apps: publicApps(ws, Object.fromEntries([...OAUTH_PROVIDERS, 'google'].map(p => [p, defaultRedirect(config.appUrl, p)]))),
    ownProviders: OWN_PROVIDERS,
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

export function profilesOf(accounts: SocialAccount[]): SocialProfile[] {
  const m = new Map<string, SocialProfile>()
  for (const a of accounts) if (a.profileId && !m.has(a.profileId)) m.set(a.profileId, { id: a.profileId, name: a.profileName ?? a.profileId })
  return [...m.values()]
}

export function parseProfiles(provider: SocialProvider, data: unknown, accounts: SocialAccount[]): SocialProfile[] {
  if (provider !== 'uploadpost') return profilesOf(accounts)
  const obj = (data ?? {}) as Record<string, unknown>
  const list = Array.isArray(obj.profiles) ? obj.profiles as Record<string, unknown>[] : []
  return list.map(p => str(p.username ?? p.id)).filter(Boolean).map(id => ({ id, name: id }))
}

export function parseAccounts(provider: SocialProvider, data: unknown): SocialAccount[] {
  const out: SocialAccount[] = []
  const obj = (data ?? {}) as Record<string, unknown>
  if (provider === 'zernio') {
    const list = Array.isArray(data) ? data : Array.isArray(obj.accounts) ? obj.accounts : Array.isArray(obj.data) ? obj.data : []
    for (const a of list as Record<string, unknown>[]) {
      if (a.isActive === false) continue
      const platform = str(a.platform ?? a.type ?? a.provider)
      const name = str(a.displayName ?? a.username ?? a.name ?? a.handle)
      const prof = a.profileId
      const profileId = prof && typeof prof === 'object' ? str((prof as Record<string, unknown>)._id ?? (prof as Record<string, unknown>).id) : str(prof)
      const profileName = prof && typeof prof === 'object' ? str((prof as Record<string, unknown>).name) : ''
      const id = str(a._id ?? a.id) || `${platform}:${name}`
      if (platform || name) out.push({ id, platform: platform || '?', name, profileId: profileId || null, profileName: profileName || null })
    }
    return out
  }
  const profiles = Array.isArray(obj.profiles) ? obj.profiles : Array.isArray(data) ? data : []
  for (const p of profiles as Record<string, unknown>[]) {
    const social = (p.social_accounts ?? {}) as Record<string, unknown>
    const profileId = str(p.username ?? p.id) || null
    for (const [platform, v] of Object.entries(social)) {
      if (!v) continue
      const acc = (typeof v === 'object' ? v : {}) as Record<string, unknown>
      out.push({ id: `${profileId}:${platform}`, platform, name: str(acc.handle ?? acc.display_name ?? acc.username ?? p.username) + (acc.reauth_required ? ' (!)' : ''), profileId, profileName: profileId })
    }
  }
  return out
}

export async function listSocialAccounts(cfg: SocialConfig, fetchImpl: FetchLike = fetch): Promise<{ ok: true, accounts: SocialAccount[], profiles: SocialProfile[], ms: number } | { ok: false, code: string, error?: string }> {
  if (!cfg.apiKey) return { ok: false, code: 'no_key' }
  const preset = SOCIAL_PROVIDERS[cfg.provider]
  const started = Date.now()
  if (cfg.keySource === 'hosted' && !cfg.profileId) return { ok: true, accounts: [], profiles: [], ms: 0 }
  const scope = cfg.keySource === 'hosted' ? `?profileId=${encodeURIComponent(cfg.profileId!)}` : ''
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetchImpl(`${preset.baseUrl}${preset.accountsPath}${scope}`, { method: 'GET', headers: { Authorization: preset.auth(cfg.apiKey), Accept: 'application/json' }, signal: ctrl.signal })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      const text = res.status >= 500 || looksHtml(raw) ? '' : redactKey(raw, cfg.apiKey).slice(0, 200)
      return { ok: false, code: res.status === 401 || res.status === 403 ? 'auth' : res.status === 404 ? 'not_found' : res.status === 429 ? 'rate' : 'other', error: `${statusText(res.status)}${text ? `: ${text}` : ''}` }
    }
    const data = await res.json().catch(() => null)
    const all = parseAccounts(cfg.provider, data)
    const accounts = (cfg.keySource === 'hosted' ? all.filter(a => a.profileId === cfg.profileId) : all).slice(0, 100)
    return { ok: true, accounts, profiles: parseProfiles(cfg.provider, data, accounts).slice(0, 50), ms: Date.now() - started }
  }
  catch (err) {
    return { ok: false, code: 'network', error: redactKey((err as Error).message, cfg.apiKey).slice(0, 200) }
  }
  finally {
    clearTimeout(timer)
  }
}
