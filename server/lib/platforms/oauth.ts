import { createHash, randomBytes } from 'node:crypto'
import type { FetchLike } from '../outlets'
import { instagramAuthorizeUrl, instagramExchange } from './instagram'
import { metaAuthorizeUrl, metaExchange } from './meta'
import { linkedinAuthorizeUrl, linkedinExchange } from './linkedin'
import { threadsAuthorizeUrl, threadsExchange } from './threads'
import { tiktokAuthorizeUrl, tiktokExchange } from './tiktok'
import { PlatformError, type Creds, type SocialConn } from './types'
import { xAuthorizeUrl, xExchange } from './x'
import { youtubeAuthorizeUrl, youtubeExchange } from './youtube'

export const OAUTH_PROVIDERS = ['meta', 'instagram', 'threads', 'linkedin', 'tiktok', 'x', 'youtube'] as const
export type OAuthProvider = typeof OAUTH_PROVIDERS[number]

export function isOAuthProvider(p: string): p is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(p)
}

export const SHARED_APP: Record<string, string> = { youtube: 'google' }

export function appOf(provider: string): string {
  return SHARED_APP[provider] ?? provider
}

export function defaultRedirect(appUrl: string, provider: string): string {
  return `${appUrl}/api/connect/${appOf(provider)}/callback`
}

export function newState(): string {
  return randomBytes(18).toString('base64url')
}

export function newVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function usesPkce(provider: OAuthProvider): boolean {
  return provider === 'x'
}

type App = { clientId: string, clientSecret: string, redirectUri: string }

export function authorizeUrl(provider: OAuthProvider, app: Pick<App, 'clientId' | 'redirectUri'>, state: string, verifier?: string): string {
  if (provider === 'x') return xAuthorizeUrl(app, state, pkceChallenge(verifier ?? ''))
  if (provider === 'meta') return metaAuthorizeUrl(app, state)
  if (provider === 'instagram') return instagramAuthorizeUrl(app, state)
  if (provider === 'threads') return threadsAuthorizeUrl(app, state)
  if (provider === 'linkedin') return linkedinAuthorizeUrl(app, state)
  if (provider === 'youtube') return youtubeAuthorizeUrl(app, state)
  return tiktokAuthorizeUrl(app, state)
}

export async function exchangeCode(provider: OAuthProvider, app: App, code: string, f: FetchLike, verifier?: string): Promise<{ conn: Omit<SocialConn, 'id' | 'secret'>, creds: Creds }[]> {
  if (provider === 'x') return xExchange(app, code, verifier, f)
  if (provider === 'meta') return metaExchange(app, code, f)
  if (provider === 'instagram') return instagramExchange(app, code, f)
  if (provider === 'threads') return threadsExchange(app, code, f)
  if (provider === 'linkedin') return linkedinExchange(app, code, f)
  if (provider === 'youtube') return youtubeExchange(app, code, f)
  return tiktokExchange(app, code, f)
}

export function parsePastedRedirect(input: string): { code: string, state: string | null } {
  const raw = input.trim()
  if (!raw) throw new PlatformError('Leere Eingabe')
  if (!/[?&#]code=/.test(raw) && !/^https?:/i.test(raw)) return { code: raw.replace(/#_$/, ''), state: null }
  const u = new URL(raw.replace('#', raw.includes('?') ? '&' : '?'))
  const err = u.searchParams.get('error_description') ?? u.searchParams.get('error')
  if (err) throw new PlatformError(`Abgelehnt: ${err}`)
  const code = u.searchParams.get('code')
  if (!code) throw new PlatformError('In der Adresse steht kein "code=". Bitte die ganze Adresse aus der Adresszeile kopieren.')
  return { code: code.replace(/#_$/, ''), state: u.searchParams.get('state') }
}
